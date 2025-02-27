let assert = require('assert');
let _ = require('lodash');
let APIBuilder = require('taskcluster-lib-api');
let Entity = require('azure-entities');
let taskCreds = require('./task-creds');

// Maximum number runs allowed
const MAX_RUNS_ALLOWED = 50;
// Priority levels in order from high to low
const PRIORITY_LEVELS = [
  'highest',
  'very-high',
  'high',
  'medium',
  'low',
  'very-low',
  'lowest',
];

/**
 * **Azure Queue Invariants**
 *
 * We use azure queue storage queues for 3 purposes:
 *   A) distribution of tasks to workers,
 *   B) expiration of task-claims, and
 *   C) resolution by deadline expiration.
 *
 * Messages for the purposes of (A) are stored on queues specific the
 * _provisionerId_ and _workerType_ of the tasks. All messages in azure queues
 * are advisory. Meaning that duplicating them, or forgetting to delete them and
 * handling them twice shall not cause issues.
 *
 * That said we do need a few invariants, this comment doesn't attempt to
 * formally establish correctness. Instead we just seek to explain the
 * intuition, so others have a chance and understanding what is going on.
 *
 *  i)    For any `pending` task there is at least one message with payload
 *        `{taskId, runId}` in a _workerType_ specific queue.
 *
 *  ii)   For any `running` task there is at least one message with payload
 *        `{taskId, runId, takenUntil}` in the queue for claim expiration,
 *        such that the message becomes visible after the claim on the
 *        current run has expired.
 *
 *  iii)  For any unresolved task there is at least one message with payload
 *        `{taskId, deadline}` in the queue for deadline resolution, such that
 *        the message becomes visible after the tasks deadline has expired.
 *
 * Using invariants above it's easy to ensure (A), (B) and (C), so long as we
 * always remember that a message is only advisory. Hence, if the task mentioned
 * doesn't exist, or is already resolved, then no error is reported and no
 * action is taken.
 *
 * To avoid the case, where we ignore the only message during expiration of
 * claims (B) due to server clock drift, we shall put the `takenUntil` time
 * into the message, so we just check if it has been updated to see if the
 * message is recent. We shall employ the same trick to ensure that clock drift
 * can't cause the last deadline message to get ignored either.
 */

// Common patterns URL parameters
let SLUGID_PATTERN = /^[A-Za-z0-9_-]{8}[Q-T][A-Za-z0-9_-][CGKOSWaeimquy26-][A-Za-z0-9_-]{10}[AQgw]$/;
let GENERIC_ID_PATTERN = /^[a-zA-Z0-9-_]{1,38}$/;
let RUN_ID_PATTERN = /^[1-9]*[0-9]+$/;

/** API end-point for version v1/ */
let builder = new APIBuilder({
  title: 'Queue API Documentation',
  description: [
    'The queue service is responsible for accepting tasks and track their state',
    'as they are executed by workers. In order ensure they are eventually',
    'resolved.',
    '',
    'This document describes the API end-points offered by the queue. These ',
    'end-points targets the following audience:',
    ' * Schedulers, who create tasks to be executed,',
    ' * Workers, who execute tasks, and',
    ' * Tools, that wants to inspect the state of a task.',
  ].join('\n'),
  serviceName: 'queue',
  apiVersion: 'v1',
  params: {
    taskId: SLUGID_PATTERN,
    taskGroupId: SLUGID_PATTERN,
    provisionerId: GENERIC_ID_PATTERN,
    workerType: GENERIC_ID_PATTERN,
    workerGroup: GENERIC_ID_PATTERN,
    workerId: GENERIC_ID_PATTERN,
    runId: RUN_ID_PATTERN,
    name: /^[\x20-\x7e]+$/, // Artifact names must be printable ASCII
  },
  context: [
    'Task', // data.Task instance
    'Artifact', // data.Artifact instance
    'TaskGroup', // data.TaskGroup instance
    'taskGroupExpiresExtension', // Time delay before expiring a task-group
    'TaskGroupMember', // data.TaskGroupMember instance
    'TaskGroupActiveSet', // data.TaskGroupMember instance (but in a different table)
    'TaskDependency', // data.TaskDependency instance
    'Provisioner', // data.Provisioner instance
    'WorkerType', // data.WorkerType instance
    'Worker', // data.Worker instance
    'publicBucket', // bucket instance for public artifacts
    'privateBucket', // bucket instance for private artifacts
    'publisher', // publisher from base.Exchanges
    'claimTimeout', // Number of seconds before a claim expires
    'queueService', // Azure QueueService object from queueservice.js
    'regionResolver', // Instance of EC2RegionResolver,
    'credentials', // TC credentials for issuing temp creds on claim
    'dependencyTracker', // Instance of DependencyTracker
    'monitor', // base.monitor instance
    'workClaimer', // Instance of WorkClaimer
    'workerInfo', // Instance of WorkerInfo
    'useCloudMirror', // If true, use the cloud-mirror service
    'cloudMirrorHost', // Hostname of the cloud-mirror service
    'artifactRegion', // Region where artifacts are stored (no cloud-mirror)
    'LRUcache', // LRU cache for tasks
  ],
});

// Export builder
module.exports = builder;

/** Get task */
builder.declare({
  method: 'get',
  route: '/task/:taskId',
  name: 'task',
  stability: APIBuilder.stability.stable,
  category: 'Tasks',
  idempotent: true,
  output: 'task.yml',
  title: 'Get Task Definition',
  description: [
    'This end-point will return the task-definition. Notice that the task',
    'definition may have been modified by queue, if an optional property is',
    'not specified the queue may provide a default value.',
  ].join('\n'),
}, async function(req, res) {
  const {taskId} = req.params;

  // Load Task entity if it's absent from cache
  let task;
  if (this.LRUcache.has(taskId)) {
    task = this.LRUcache.get(taskId);
  } else {
    task = await this.Task.load({taskId}, true);
    this.LRUcache.set(taskId, task);
  }

  // Handle cases where the task doesn't exist
  if (!task) {
    return res.reportError('ResourceNotFound', [
      '`{{taskId}}` does not correspond to a task that exists.',
      'Are you sure this task has already been submitted?',
    ].join('\n'), {taskId});
  }

  // Create task definition
  let definition = await task.definition();

  return res.reply(definition);
});

/** Get task status */
builder.declare({
  method: 'get',
  route: '/task/:taskId/status',
  name: 'status',
  stability: APIBuilder.stability.stable,
  input: undefined, // No input is accepted
  output: 'task-status-response.yml',
  category: 'Tasks',
  title: 'Get task status',
  description: [
    'Get task status structure from `taskId`',
  ].join('\n'),
}, async function(req, res) {
  // Load Task entity
  let task = await this.Task.load({
    taskId: req.params.taskId,
  }, true);

  // Handle cases where the task doesn't exist
  if (!task) {
    return res.reportError('ResourceNotFound', [
      '`{{taskId}}` does not correspond to a task that exists.',
      'Are you sure this task exists?',
    ].join('\n'), {
      taskId: req.params.taskId,
    });
  }

  // Reply with task status
  return res.reply({
    status: task.status(),
  });
});

/** List taskIds by taskGroupId */
builder.declare({
  method: 'get',
  route: '/task-group/:taskGroupId/list',
  query: {
    continuationToken: Entity.continuationTokenPattern,
    limit: /^[0-9]+$/,
  },
  name: 'listTaskGroup',
  stability: APIBuilder.stability.stable,
  category: 'Tasks',
  output: 'list-task-group-response.yml',
  title: 'List Task Group',
  description: [
    'List tasks sharing the same `taskGroupId`.',
    '',
    'As a task-group may contain an unbounded number of tasks, this end-point',
    'may return a `continuationToken`. To continue listing tasks you must call',
    'the `listTaskGroup` again with the `continuationToken` as the',
    'query-string option `continuationToken`.',
    '',
    'By default this end-point will try to return up to 1000 members in one',
    'request. But it **may return less**, even if more tasks are available.',
    'It may also return a `continuationToken` even though there are no more',
    'results. However, you can only be sure to have seen all results if you',
    'keep calling `listTaskGroup` with the last `continuationToken` until you',
    'get a result without a `continuationToken`.',
    '',
    'If you are not interested in listing all the members at once, you may',
    'use the query-string option `limit` to return fewer.',
  ].join('\n'),
}, async function(req, res) {
  let taskGroupId = req.params.taskGroupId;
  let continuation = req.query.continuationToken || null;
  let limit = parseInt(req.query.limit || 1000, 10);

  // Find taskGroup and list of members
  let [
    taskGroup,
    members,
  ] = await Promise.all([
    this.TaskGroup.load({taskGroupId}, true),
    this.TaskGroupMember.query({
      taskGroupId,
      expires: Entity.op.greaterThanOrEqual(new Date()),
    }, {continuation, limit}),
  ]);

  // If no taskGroup was found
  if (!taskGroup) {
    return res.reportError('ResourceNotFound',
      'No task-group with taskGroupId: `{{taskGroupId}}`', {
        taskGroupId,
      },
    );
  }

  /* eslint-disable no-extra-parens */
  // Load tasks
  let tasks = (await Promise.all(members.entries.map(member => {
    return this.Task.load({taskId: member.taskId}, true);
  }))).filter(task => {
    // Remove tasks that don't exist, this happens on creation errors
    // Remove tasks with wrong schedulerId, this shouldn't happen unless of some
    // creation errors (probably something that involves dependency errors).
    return task && task.schedulerId === taskGroup.schedulerId;
  });
  /* eslint-enable no-extra-parens */

  // Build result
  let result = {
    taskGroupId,
    tasks: await Promise.all(tasks.map(async (task) => {
      return {
        status: task.status(),
        task: await task.definition(),
      };
    })),
  };
  if (members.continuation) {
    result.continuationToken = members.continuation;
  }

  return res.reply(result);
});

/** List tasks dependents */
builder.declare({
  method: 'get',
  route: '/task/:taskId/dependents',
  query: {
    continuationToken: Entity.continuationTokenPattern,
    limit: /^[0-9]+$/,
  },
  name: 'listDependentTasks',
  category: 'Tasks',
  stability: APIBuilder.stability.stable,
  output: 'list-dependent-tasks-response.yml',
  title: 'List Dependent Tasks',
  description: [
    'List tasks that depend on the given `taskId`.',
    '',
    'As many tasks from different task-groups may dependent on a single tasks,',
    'this end-point may return a `continuationToken`. To continue listing',
    'tasks you must call `listDependentTasks` again with the',
    '`continuationToken` as the query-string option `continuationToken`.',
    '',
    'By default this end-point will try to return up to 1000 tasks in one',
    'request. But it **may return less**, even if more tasks are available.',
    'It may also return a `continuationToken` even though there are no more',
    'results. However, you can only be sure to have seen all results if you',
    'keep calling `listDependentTasks` with the last `continuationToken` until',
    'you get a result without a `continuationToken`.',
    '',
    'If you are not interested in listing all the tasks at once, you may',
    'use the query-string option `limit` to return fewer.',
  ].join('\n'),
}, async function(req, res) {
  let taskId = req.params.taskId;
  let continuation = req.query.continuationToken || null;
  let limit = parseInt(req.query.limit || 1000, 10);

  // Find task and list dependents
  let [
    task,
    dependents,
  ] = await Promise.all([
    this.Task.load({taskId}, true),
    this.TaskDependency.query({
      taskId,
      expires: Entity.op.greaterThanOrEqual(new Date()),
    }, {continuation, limit}),
  ]);

  // Check if task exists
  if (!task) {
    return res.reportError(
      'ResourceNotFound',
      'Task with taskId: `{{taskId}}` was not found',
      {taskId},
    );
  }

  /* eslint-disable no-extra-parens */
  // Load tasks
  let tasks = (await Promise.all(dependents.entries.map(dependent => {
    return this.Task.load({taskId: dependent.dependentTaskId}, true);
  }))).filter(task => !!task);
  /* eslint-enable no-extra-parens */

  // Build result
  let result = {
    taskId,
    tasks: await Promise.all(tasks.map(async (task) => {
      return {
        status: task.status(),
        task: await task.definition(),
      };
    })),
  };
  if (dependents.continuation) {
    result.continuationToken = dependents.continuation;
  }

  return res.reply(result);
});

/**
 * Generate the list of acceptable priorities for a task with this priority
 */
const authorizeTaskCreation = async function(req, taskId, taskDef) {
  const priority = taskDef.priority === 'normal' ? 'lowest' : taskDef.priority;
  const priorities = PRIORITY_LEVELS.slice(0, PRIORITY_LEVELS.indexOf(priority) + 1);
  assert(priorities.length > 0, 'must have a non-empty list of priorities');

  await req.authorize({
    legacyScopes: priority === 'lowest',
    taskId,
    priorities,
    routes: taskDef.routes,
    scopes: taskDef.scopes,
    schedulerId: taskDef.schedulerId,
    taskGroupId: taskDef.taskGroupId || taskId,
    provisionerId: taskDef.provisionerId,
    workerType: taskDef.workerType,
  });
};

/** Construct default values and validate dates */
let patchAndValidateTaskDef = function(taskId, taskDef) {
  // Set taskGroupId to taskId if not provided
  if (!taskDef.taskGroupId) {
    taskDef.taskGroupId = taskId;
  }

  // Ensure: created < now < deadline (with drift up to 15 min)
  let created = new Date(taskDef.created);
  let deadline = new Date(taskDef.deadline);
  if (created.getTime() < new Date().getTime() - 15 * 60 * 1000) {
    return {
      code: 'InputError',
      message: 'Created timestamp cannot be in the past (max 15min drift)',
      details: {created: taskDef.created},
    };
  }
  if (created.getTime() > new Date().getTime() + 15 * 60 * 1000) {
    return {
      code: 'InputError',
      message: 'Created timestamp cannot be in the future (max 15min drift)',
      details: {created: taskDef.created},
    };
  }
  if (created.getTime() > deadline.getTime()) {
    return {
      code: 'InputError',
      message: 'Deadline cannot be past created',
      details: {created: taskDef.created, deadline: taskDef.deadline},
    };
  }
  if (deadline.getTime() < new Date().getTime()) {
    return {
      code: 'InputError',
      message: 'Deadline cannot be in the past',
      details: {deadline: taskDef.deadline},
    };
  }

  let msToDeadline = deadline.getTime() - new Date().getTime();
  // Validate that deadline is less than 5 days from now, allow 15 min drift
  if (msToDeadline > 5 * 24 * 60 * 60 * 1000 + 15 * 60 * 1000) {
    return {
      code: 'InputError',
      message: 'Deadline cannot be more than 5 days into the future',
      details: {deadline: taskDef.deadline},
    };
  }

  // Set expires, if not defined
  if (!taskDef.expires) {
    let expires = new Date(taskDef.deadline);
    expires.setFullYear(expires.getFullYear() + 1);
    taskDef.expires = expires.toJSON();
  }

  // Validate that expires is past deadline
  if (deadline.getTime() > new Date(taskDef.expires).getTime()) {
    return {
      code: 'InputError',
      message: 'Expires cannot be before the deadline',
      details: {deadline: taskDef.deadline, expires: taskDef.expires},
    };
  }

  // Ensure that date formats are encoded as we store them for idempotent
  // operations to work with date format that has more or fewer digits
  taskDef.created = new Date(taskDef.created).toJSON();
  taskDef.deadline = new Date(taskDef.deadline).toJSON();
  taskDef.expires = new Date(taskDef.expires).toJSON();

  // Migrate normal -> lowest, as it is the new default
  if (taskDef.priority === 'normal') {
    taskDef.priority = 'lowest';
  }

  return null;
};

/** Ensure the taskGroup exists and that membership is declared */
let ensureTaskGroup = async (ctx, taskId, taskDef, res) => {
  let taskGroupId = taskDef.taskGroupId;
  let taskGroup = await ctx.TaskGroup.load({taskGroupId}, true);
  let expires = new Date(taskDef.expires);
  let taskGroupExpiration = new Date(
    expires.getTime() + ctx.taskGroupExpiresExtension * 1000,
  );
  if (!taskGroup) {
    taskGroup = await ctx.TaskGroup.create({
      taskGroupId,
      schedulerId: taskDef.schedulerId,
      expires: taskGroupExpiration,
    }).catch(err => {
      // We only handle cases where the entity already exists
      if (!err || err.code !== 'EntityAlreadyExists') {
        throw err;
      }
      return ctx.TaskGroup.load({taskGroupId});
    });
  }
  if (taskGroup.schedulerId !== taskDef.schedulerId) {
    res.reportError(
      'RequestConflict', [
        'Task group `{{taskGroupId}}` contains tasks with',
        'schedulerId `{{taskGroupSchedulerId}}`. You are attempting',
        'to include tasks from schedulerId `{{taskSchedulerId}}`,',
        'which is not permitted.',
        'All tasks in the same task-group must have the same schedulerId.',
      ].join('\n'), {
        taskGroupId,
        taskGroupSchedulerId: taskGroup.schedulerId,
        taskSchedulerId: taskDef.schedulerId,
      });
    return false;
  }
  // Update taskGroup.expires if necessary
  await taskGroup.modify(taskGroup => {
    if (taskGroup.expires.getTime() < expires.getTime()) {
      taskGroup.expires = taskGroupExpiration;
    }
  });

  // Ensure the group membership relation is constructed too
  await ctx.TaskGroupMember.create({
    taskGroupId,
    taskId,
    expires,
  }).catch(err => {
    // If the entity already exists, then we're happy no need to crash
    if (!err || err.code !== 'EntityAlreadyExists') {
      throw err;
    }
  });

  // Now we also add the task to the group size counters as well
  await ctx.TaskGroupActiveSet.create({
    taskGroupId,
    taskId,
    expires,
  }).catch(async (err) => {
    // If the entity already exists, then we're happy no need to crash
    if (!err || err.code !== 'EntityAlreadyExists') {
      throw err;
    }

    let active = await ctx.TaskGroupActiveSet.load({taskId, taskGroupId});

    if (!_.isEqual(new Date(active.expires), expires)) {
      return res.reportError('RequestConflict', [
        'taskId `{{taskId}}` already used by another task.',
        'This could be the result of faulty idempotency!',
      ].join('\n'), {
        taskId,
      });
    }
  });

  return true;
};

/** Create tasks */
builder.declare({
  method: 'put',
  route: '/task/:taskId',
  name: 'createTask',
  stability: APIBuilder.stability.stable,
  idempotent: true,
  category: 'Tasks',
  scopes: {AllOf: [
    {for: 'scope', in: 'scopes', each: '<scope>'},
    {for: 'route', in: 'routes', each: 'queue:route:<route>'},
    {AnyOf: [
      {AllOf: [
        'queue:scheduler-id:<schedulerId>',
        {AnyOf: [
          {
            for: 'priority',
            in: 'priorities',
            each: 'queue:create-task:<priority>:<provisionerId>/<workerType>',
          },
        ]},
      ]},
      {
        if: 'legacyScopes',
        then: {AnyOf: [
          'queue:create-task:<provisionerId>/<workerType>',
          {
            AllOf: [
              'queue:define-task:<provisionerId>/<workerType>',
              'queue:task-group-id:<schedulerId>/<taskGroupId>',
              'queue:schedule-task:<schedulerId>/<taskGroupId>/<taskId>',
            ],
          },
        ]},
      },
    ]},
  ]},
  input: 'create-task-request.yml',
  output: 'task-status-response.yml',
  title: 'Create New Task',
  description: [
    'Create a new task, this is an **idempotent** operation, so repeat it if',
    'you get an internal server error or network connection is dropped.',
    '',
    '**Task `deadline`**: the deadline property can be no more than 5 days',
    'into the future. This is to limit the amount of pending tasks not being',
    'taken care of. Ideally, you should use a much shorter deadline.',
    '',
    '**Task expiration**: the `expires` property must be greater than the',
    'task `deadline`. If not provided it will default to `deadline` + one',
    'year. Notice, that artifacts created by task must expire before the task.',
    '',
    '**Task specific routing-keys**: using the `task.routes` property you may',
    'define task specific routing-keys. If a task has a task specific ',
    'routing-key: `<route>`, then when the AMQP message about the task is',
    'published, the message will be CC\'ed with the routing-key: ',
    '`route.<route>`. This is useful if you want another component to listen',
    'for completed tasks you have posted.  The caller must have scope',
    '`queue:route:<route>` for each route.',
    '',
    '**Dependencies**: any tasks referenced in `task.dependencies` must have',
    'already been created at the time of this call.',
    '',
    '**Scopes**: Note that the scopes required to complete this API call depend',
    'on the content of the `scopes`, `routes`, `schedulerId`, `priority`,',
    '`provisionerId`, and `workerType` properties of the task definition.',
    '',
    '**Legacy Scopes**: The `queue:create-task:..` scope without a priority and',
    'the `queue:define-task:..` and `queue:task-group-id:..` scopes are considered',
    'legacy and should not be used. Note that the new, non-legacy scopes require',
    'a `queue:scheduler-id:..` scope as well as scopes for the proper priority.',
  ].join('\n'),
}, async function(req, res) {
  let taskId = req.params.taskId;
  let taskDef = req.body;

  await authorizeTaskCreation(req, taskId, taskDef);

  // Patch default values and validate timestamps
  let detail = patchAndValidateTaskDef(taskId, taskDef);
  if (detail) {
    return res.reportError(detail.code, detail.message, detail.details);
  }

  if (taskDef.scopes.some(s => s.endsWith('**'))) {
    return res.reportError('InputError', 'scopes must not end with `**`', {});
  }

  // Ensure group membership is declared, and that schedulerId isn't conflicting
  if (!await ensureTaskGroup(this, taskId, taskDef, res)) {
    return;
  }

  // Parse timestamps
  let created = new Date(taskDef.created);
  let deadline = new Date(taskDef.deadline);
  let expires = new Date(taskDef.expires);

  // Insert entry in deadline queue
  await this.queueService.putDeadlineMessage(
    taskId,
    taskDef.taskGroupId,
    taskDef.schedulerId,
    deadline,
  );

  let task;

  // Try to create Task entity
  try {
    let runs = [];
    // Add run if there is no dependencies
    if (taskDef.dependencies.length === 0) {
      runs.push({
        state: 'pending',
        reasonCreated: 'scheduled',
        scheduled: new Date().toJSON(),
      });
    }
    task = await this.Task.create({
      taskId: taskId,
      provisionerId: taskDef.provisionerId,
      workerType: taskDef.workerType,
      schedulerId: taskDef.schedulerId,
      taskGroupId: taskDef.taskGroupId,
      dependencies: taskDef.dependencies,
      requires: taskDef.requires,
      routes: taskDef.routes,
      priority: taskDef.priority,
      retries: taskDef.retries,
      retriesLeft: taskDef.retries,
      created: created,
      deadline: deadline,
      expires: expires,
      scopes: taskDef.scopes,
      payload: taskDef.payload,
      metadata: taskDef.metadata,
      tags: taskDef.tags,
      extra: taskDef.extra,
      runs: runs,
      takenUntil: new Date(0),
    });
  } catch (err) {
    if (err && err.code === 'PropertyTooLarge') {
      return res.reportError('InputError', err.toString(), {});
    }

    // We can handle cases where entity already exists, not that, we re-throw
    if (!err || err.code !== 'EntityAlreadyExists') {
      throw err;
    }

    // load task, and task definition
    task = await this.Task.load({taskId: taskId});
    let def = await task.definition();

    // Compare the two task definitions
    if (!_.isEqual(taskDef, def)) {
      return res.reportError('RequestConflict', [
        'taskId `{{taskId}}` already used by another task.',
        'This could be the result of faulty idempotency!',
        'Existing task definition was:\n ```js\n{{existingTask}}\n```',
        'This request tried to define:\n ```js\n{{taskDefinition}}\n```',
      ].join('\n'), {
        taskId,
        existingTask: def,
        taskDefinition: taskDef,
      });
    }
  }

  // Track dependencies, if not already scheduled
  if (task.state() === 'unscheduled') {
    // Track dependencies, adds a pending run if ready to run
    let err = await this.dependencyTracker.trackDependencies(task);
    // If we get an error here the task will be left in state = 'unscheduled',
    // any attempt to use the same taskId will fail. And eventually the task
    // will be resolved deadline-expired. But since createTask never returned
    // successfully...
    if (err) {
      return res.reportError('InputError', err.message, err.details);
    }
  }

  // Construct task status, as we'll return this many times
  let status = task.status();
  let taskPulseContents = {
    tags: task.tags,
  };

  // If first run isn't unscheduled or pending, all message must have been
  // published before, this can happen if we came from the catch-branch
  // (it's unlikely to happen). But no need to publish messages again
  let runZeroState = (task.runs[0] || {state: 'unscheduled'}).state;
  if (runZeroState !== 'unscheduled' && runZeroState !== 'pending') {
    return res.reply({status});
  }

  // Publish task-defined message, we want this arriving before the
  // task-pending message, so we have to await publication here
  await this.publisher.taskDefined({status, task: taskPulseContents}, task.routes);
  this.monitor.log.taskDefined({taskId});

  // If first run is pending we publish messages about this
  if (runZeroState === 'pending') {
    await Promise.all([
      // Put message into the task pending queue
      this.queueService.putPendingMessage(task, 0),

      // Put message in appropriate azure queue, and publish message to pulse
      this.publisher.taskPending({status, task: taskPulseContents, runId: 0}, task.routes),
    ]);
    this.monitor.log.taskPending({taskId, runId: 0});
  }

  // Reply
  return res.reply({status});
});

/** Define tasks */
builder.declare({
  method: 'post',
  route: '/task/:taskId/define',
  name: 'defineTask',
  stability: APIBuilder.stability.deprecated,
  category: 'Tasks',
  scopes: {AllOf: [
    {for: 'scope', in: 'scopes', each: '<scope>'},
    {for: 'route', in: 'routes', each: 'queue:route:<route>'},
    {AnyOf: [
      {AllOf: [
        'queue:scheduler-id:<schedulerId>',
        {AnyOf: [
          {
            for: 'priority',
            in: 'priorities',
            each: 'queue:create-task:<priority>:<provisionerId>/<workerType>',
          },
        ]},
      ]},
      {
        if: 'legacyScopes',
        then: {AnyOf: [
          'queue:define-task:<provisionerId>/<workerType>',
          'queue:create-task:<provisionerId>/<workerType>',
          {
            AllOf: [
              'queue:define-task:<provisionerId>/<workerType>',
              'queue:task-group-id:<schedulerId>/<taskGroupId>',
            ],
          },
        ]},
      },
    ]},
  ]},
  input: 'create-task-request.yml',
  output: 'task-status-response.yml',
  title: 'Define Task',
  description: [
    '**Deprecated**, this is the same as `createTask` with a **self-dependency**.',
    'This is only present for legacy.',
  ].join('\n'),
}, async function(req, res) {
  let taskId = req.params.taskId;
  let taskDef = req.body;

  await authorizeTaskCreation(req, taskId, taskDef);

  // Patch default values and validate timestamps
  let detail = patchAndValidateTaskDef(taskId, taskDef);
  if (detail) {
    return res.reportError(detail.code, detail.message, detail.details);
  }

  // Ensure we have a self-dependency, this is how defineTask works now
  if (!_.includes(taskDef.dependencies, taskId)) {
    // Trick as taskDef.dependencies may be a default from schema validation
    // HACK: Yes, schema validator really should clone its default values!
    taskDef.dependencies = _.flatten([taskId, taskDef.dependencies]);
  }

  // Ensure group membership is declared, and that schedulerId isn't conflicting
  if (!await ensureTaskGroup(this, taskId, taskDef, res)) {
    return;
  }

  // Parse timestamps
  let created = new Date(taskDef.created);
  let deadline = new Date(taskDef.deadline);
  let expires = new Date(taskDef.expires);

  // Insert entry in deadline queue (garbage entries are acceptable)
  await this.queueService.putDeadlineMessage(
    taskId,
    taskDef.taskGroupId,
    taskDef.schedulerId,
    deadline,
  );

  let task;

  // Try to create Task entity
  try {
    task = await this.Task.create({
      taskId: taskId,
      provisionerId: taskDef.provisionerId,
      workerType: taskDef.workerType,
      schedulerId: taskDef.schedulerId,
      taskGroupId: taskDef.taskGroupId,
      dependencies: taskDef.dependencies,
      requires: taskDef.requires,
      routes: taskDef.routes,
      priority: taskDef.priority,
      retries: taskDef.retries,
      retriesLeft: taskDef.retries,
      created: created,
      deadline: deadline,
      expires: expires,
      scopes: taskDef.scopes,
      payload: taskDef.payload,
      metadata: taskDef.metadata,
      tags: taskDef.tags,
      extra: taskDef.extra,
      runs: [],
      takenUntil: new Date(0),
    });
  } catch (err) {
    if (err && err.code === 'PropertyTooLarge') {
      return res.reportError('InputError', err.toString(), {});
    }

    // We can handle cases where entity already exists, not that, we re-throw
    if (!err || err.code !== 'EntityAlreadyExists') {
      throw err;
    }

    // load task, and task definition
    task = await this.Task.load({taskId: taskId});
    let def = await task.definition();

    // Compare the two task definitions
    // (ignore runs as this method don't create them)
    if (!_.isEqual(taskDef, def)) {
      return res.reportError('RequestConflict', [
        'taskId `{{taskId}}` already used by another task.',
        'This could be the result of faulty idempotency!',
        'Existing task definition was:\n ```js\n{{existingTask}}\n```',
        'This request tried to define:\n ```js\n{{taskDefinition}}\n```',
      ].join('\n'), {
        taskId,
        existingTask: def,
        taskDefinition: taskDef,
      });
    }
  }

  // Track dependencies, if not already scheduled
  if (task.state() === 'unscheduled') {
    // Track dependencies, adds a pending run if ready to run
    let err = await this.dependencyTracker.trackDependencies(task);
    // We get an error here the task will be left in state = 'unscheduled',
    // any attempt to use the same taskId will fail. And eventually the task
    // will be resolved deadline-expired. But since createTask never returned
    // successfully...
    if (err) {
      return res.reportError('InputError', err.message, err.details);
    }

    // Validate sanity...
    assert(task.state() === 'unscheduled', 'task should be unscheduled here!');
  }

  // Construct task status
  let status = task.status();
  let taskPulseContents = {
    tags: task.tags,
  };

  // If runs are present, then we don't need to publish messages as this must
  // have happened already...
  // this can happen if we came from the catch-branch (it's unlikely to happen)
  if (task.runs.length > 0) {
    return res.reply({status});
  }

  // Publish task-defined message
  await this.publisher.taskDefined({status, task: taskPulseContents}, task.routes);
  this.monitor.log.taskDefined({taskId});

  // Reply
  return res.reply({status});
});

/** Schedule previously defined tasks */
builder.declare({
  method: 'post',
  route: '/task/:taskId/schedule',
  name: 'scheduleTask',
  stability: APIBuilder.stability.stable,
  category: 'Tasks',
  scopes: {AnyOf: [
    'queue:schedule-task:<schedulerId>/<taskGroupId>/<taskId>',
    {AllOf: [ // Legacy scopes
      'queue:schedule-task',
      'assume:scheduler-id:<schedulerId>/<taskGroupId>',
    ]},
  ]},
  input: undefined, // No input accepted
  output: 'task-status-response.yml',
  title: 'Schedule Defined Task',
  description: [
    'scheduleTask will schedule a task to be executed, even if it has',
    'unresolved dependencies. A task would otherwise only be scheduled if',
    'its dependencies were resolved.',
    '',
    'This is useful if you have defined a task that depends on itself or on',
    'some other task that has not been resolved, but you wish the task to be',
    'scheduled immediately.',
    '',
    'This will announce the task as pending and workers will be allowed to',
    'claim it and resolve the task.',
    '',
    '**Note** this operation is **idempotent** and will not fail or complain',
    'if called with a `taskId` that is already scheduled, or even resolved.',
    'To reschedule a task previously resolved, use `rerunTask`.',
  ].join('\n'),
}, async function(req, res) {
  // Load Task entity
  let taskId = req.params.taskId;
  let task = await this.Task.load({taskId: taskId}, true);

  // If task entity doesn't exists, we return ResourceNotFound
  if (!task) {
    return res.reportError(
      'ResourceNotFound',
      'taskId `{{taskId}}` not found. Are you sure it exists?',
      {taskId},
    );
  }

  await req.authorize({
    taskId,
    schedulerId: task.schedulerId,
    taskGroupId: task.taskGroupId,
  });

  // Attempt to schedule task
  let status = await this.dependencyTracker.scheduleTask(task);

  // If null it must because deadline is exceeded
  if (status === null) {
    return res.reportError(
      'RequestConflict',
      'Task `{{taskId}}` Can\'t be scheduled past its deadline at ' +
      '{{deadline}}.', {
        taskId,
        deadline: task.deadline.toJSON(),
      },
    );
  }

  return res.reply({status});
});

/** Rerun a previously resolved task */
builder.declare({
  method: 'post',
  route: '/task/:taskId/rerun',
  name: 'rerunTask',
  stability: APIBuilder.stability.deprecated,
  category: 'Tasks',
  scopes: {AnyOf: [
    'queue:rerun-task:<schedulerId>/<taskGroupId>/<taskId>',
    {AllOf: [ // Legacy scopes
      'queue:rerun-task',
      'assume:scheduler-id:<schedulerId>/<taskGroupId>',
    ]},
  ]},
  input: undefined, // No input accepted
  output: 'task-status-response.yml',
  title: 'Rerun a Resolved Task',
  description: [
    'This method _reruns_ a previously resolved task, even if it was',
    '_completed_. This is useful if your task completes unsuccessfully, and',
    'you just want to run it from scratch again. This will also reset the',
    'number of `retries` allowed.',
    '',
    'This method is deprecated in favour of creating a new task with the same',
    'task definition (but with a new taskId).',
    '',
    'Remember that `retries` in the task status counts the number of runs that',
    'the queue have started because the worker stopped responding, for example',
    'because a spot node died.',
    '',
    '**Remark** this operation is idempotent, if you try to rerun a task that',
    'is not either `failed` or `completed`, this operation will just return',
    'the current task status.',
  ].join('\n'),
}, async function(req, res) {
  // Load Task entity
  let taskId = req.params.taskId;
  let task = await this.Task.load({taskId: taskId}, true);

  // Report ResourceNotFound, if task entity doesn't exist
  if (!task) {
    return res.reportError('ResourceNotFound', [
      '`{{taskId}}` does not correspond to a task that exists.',
      'Are you sure this task has been submitted before?',
    ].join('\n'), {
      taskId,
    });
  }

  await req.authorize({
    taskId,
    schedulerId: task.schedulerId,
    taskGroupId: task.taskGroupId,
  });

  // Validate deadline
  if (task.deadline.getTime() < new Date().getTime()) {
    return res.reportError(
      'RequestConflict',
      'Task `{{taskId}}` Can\'t be rescheduled past it\'s deadline of ' +
      '{{deadline}}.', {
        taskId,
        deadline: task.deadline.toJSON(),
      },
    );
  }

  // Ensure that we have a pending or running run
  // If creating a new one, then reset retriesLeft
  await task.modify((task) => {
    // Don't modify if there already is an active run
    let state = (_.last(task.runs) || {state: 'unscheduled'}).state;
    if (state === 'pending' || state === 'running') {
      return;
    }

    // Don't create more than MAX_RUNS_ALLOWED runs
    if (task.runs.length >= MAX_RUNS_ALLOWED) {
      return;
    }

    // Add a new run
    task.runs.push({
      state: 'pending',
      reasonCreated: 'rerun',
      scheduled: new Date().toJSON(),
    });

    // Calculate maximum number of retries allowed
    let allowedRetries = MAX_RUNS_ALLOWED - task.runs.length;

    // Reset retries left
    task.retriesLeft = Math.min(task.retries, allowedRetries);
    task.takenUntil = new Date(0);
  });

  let state = task.state();

  // If not running or pending, and we couldn't create more runs then we have
  // a conflict
  if (state !== 'pending' && state !== 'running' &&
      task.runs.length >= MAX_RUNS_ALLOWED) {
    return res.reportError(
      'RequestConflict',
      'Maximum number of runs reached ({{max_runs_allowed}}).', {
        max_runs_allowed: MAX_RUNS_ALLOWED,
      },
    );
  }

  // Put message in appropriate azure queue, and publish message to pulse,
  // if the initial run is pending
  let status = task.status();
  if (state === 'pending') {
    let runId = task.runs.length - 1;
    await Promise.all([
      this.queueService.putPendingMessage(task, runId),
      this.publisher.taskPending({
        status: status,
        runId: runId,
      }, task.routes),
    ]);
    this.monitor.log.taskPending({taskId, runId});
  }

  return res.reply({status});
});

/** Cancel a task */
builder.declare({
  method: 'post',
  route: '/task/:taskId/cancel',
  name: 'cancelTask',
  stability: APIBuilder.stability.stable,
  category: 'Tasks',
  scopes: {AnyOf: [
    'queue:cancel-task:<schedulerId>/<taskGroupId>/<taskId>',
    {AllOf: [ // Legacy scopes
      'queue:cancel-task',
      'assume:scheduler-id:<schedulerId>/<taskGroupId>',
    ]},
  ]},
  input: undefined, // No input accepted
  output: 'task-status-response.yml',
  title: 'Cancel Task',
  description: [
    'This method will cancel a task that is either `unscheduled`, `pending` or',
    '`running`. It will resolve the current run as `exception` with',
    '`reasonResolved` set to `canceled`. If the task isn\'t scheduled yet, ie.',
    'it doesn\'t have any runs, an initial run will be added and resolved as',
    'described above. Hence, after canceling a task, it cannot be scheduled',
    'with `queue.scheduleTask`, but a new run can be created with',
    '`queue.rerun`. These semantics is equivalent to calling',
    '`queue.scheduleTask` immediately followed by `queue.cancelTask`.',
    '',
    '**Remark** this operation is idempotent, if you try to cancel a task that',
    'isn\'t `unscheduled`, `pending` or `running`, this operation will just',
    'return the current task status.',
  ].join('\n'),
}, async function(req, res) {
  // Load Task entity
  let taskId = req.params.taskId;
  let task = await this.Task.load({taskId}, true);

  // Report ResourceNotFound, if task entity doesn't exist
  if (!task) {
    return res.reportError('ResourceNotFound',
      'Task `{{taskId}}` not found. Are you sure it was created?', {
        taskId,
      },
    );
  }

  await req.authorize({
    taskId,
    schedulerId: task.schedulerId,
    taskGroupId: task.taskGroupId,
  });

  // Validate deadline
  if (task.deadline.getTime() < new Date().getTime()) {
    return res.reportError(
      'RequestConflict',
      'Task `{{taskId}}` Can\'t be canceled past it\'s deadline of ' +
      '{{deadline}}.', {
        taskId,
        deadline: task.deadline.toJSON(),
      },
    );
  }

  // Modify the task
  await task.modify(async (task) => {
    let run = _.last(task.runs);
    let state = (run || {state: 'unscheduled'}).state;

    // If we have a pending task or running task, we cancel the ongoing run
    if (state === 'pending' || state === 'running') {
      run.state = 'exception';
      run.reasonResolved = 'canceled';
      run.resolved = new Date().toJSON();
    }

    // If the task wasn't scheduled, we'll add a run and resolved it canceled.
    // This is almost equivalent to calling scheduleTask and cancelTask, but
    // instead of setting `reasonCreated` to 'scheduled', we set it 'exception',
    // because this run was made solely to communicate an exception.
    if (state === 'unscheduled') {
      let now = new Date().toJSON();
      task.runs.push({
        state: 'exception',
        reasonCreated: 'exception',
        reasonResolved: 'canceled',
        scheduled: now,
        resolved: now,
      });
    }

    // Clear takenUntil
    task.takenUntil = new Date(0);
  });

  // Get the last run, there should always be one
  let run = _.last(task.runs);
  if (!run) {
    let err = new Error('There should exist a run after cancelTask!');
    err.taskId = task.taskId;
    err.status = task.status();
    this.monitor.reportError(err);
  }

  // Construct status object
  let status = task.status();

  // If the last run was canceled, resolve dependencies and publish message
  if (run.state === 'exception' && run.reasonResolved === 'canceled') {
    // Update dependency tracker
    await this.queueService.putResolvedMessage(
      taskId,
      task.taskGroupId,
      task.schedulerId,
      'exception',
    );

    // Publish message about the exception
    const runId = task.runs.length - 1;
    await this.publisher.taskException(_.defaults({
      status,
      runId,
    }, _.pick(run, 'workerGroup', 'workerId')), task.routes);
    this.monitor.log.taskException({taskId, runId});
  }

  return res.reply({status});
});

// Hack to get promises that resolve after 20s without creating a setTimeout
// for each, instead we create a new promise every 2s and reuse that.
let _lastTime = 0;
let _sleeping = null;
let sleep20Seconds = () => {
  let time = Date.now();
  if (!_sleeping || time - _lastTime > 2000) {
    _sleeping = new Promise(accept => setTimeout(accept, 20 * 1000));
  }
  return _sleeping;
};

/** Claim any task */
builder.declare({
  method: 'post',
  route: '/claim-work/:provisionerId/:workerType',
  name: 'claimWork',
  stability: APIBuilder.stability.stable,
  category: 'Worker Interface',
  scopes: {AllOf: [
    'queue:claim-work:<provisionerId>/<workerType>',
    'queue:worker-id:<workerGroup>/<workerId>',
  ]},
  input: 'claim-work-request.yml',
  output: 'claim-work-response.yml',
  title: 'Claim Work',
  description: [
    'Claim pending task(s) for the given `provisionerId`/`workerType` queue.',
    '',
    'If any work is available (even if fewer than the requested number of',
    'tasks, this will return immediately. Otherwise, it will block for tens of',
    'seconds waiting for work.  If no work appears, it will return an emtpy',
    'list of tasks.  Callers should sleep a short while (to avoid denial of',
    'service in an error condition) and call the endpoint again.  This is a',
    'simple implementation of "long polling".',
  ].join('\n'),
}, async function(req, res) {
  let provisionerId = req.params.provisionerId;
  let workerType = req.params.workerType;
  let workerGroup = req.body.workerGroup;
  let workerId = req.body.workerId;
  let count = req.body.tasks;

  await req.authorize({
    workerGroup,
    workerId,
    provisionerId,
    workerType,
  });

  const worker = await this.Worker.load({
    provisionerId,
    workerType,
    workerGroup,
    workerId,
  }, true);

  // Don't claim tasks when worker is quarantined (but do record the worker
  // being seen, and be sure to wait the 20 seconds so as not to cause a
  // tight loop of claimWork calls from the worker
  if (worker && worker.quarantineUntil.getTime() > new Date().getTime()) {
    await Promise.all([
      this.workerInfo.seen(provisionerId, workerType, workerGroup, workerId),
      sleep20Seconds(),
    ]);
    return res.reply({
      tasks: [],
    });
  }

  // Allow request to abort their claim request, if the connection closes
  let aborted = new Promise(accept => {
    sleep20Seconds().then(accept);
    res.once('close', accept);
  });

  let [result] = await Promise.all([
    this.workClaimer.claim(
      provisionerId, workerType, workerGroup, workerId, count, aborted,
    ),
    this.workerInfo.seen(provisionerId, workerType, workerGroup, workerId),
  ]);

  result.forEach(({runId, status: {taskId}}) => {
    this.monitor.log.taskClaimed({
      provisionerId,
      workerType,
      workerGroup,
      workerId,
      taskId,
      runId,
    });
  });

  await this.workerInfo.taskSeen(provisionerId, workerType, workerGroup, workerId, result);

  return res.reply({
    tasks: result,
  });
});

/** Claim a task */
builder.declare({
  method: 'post',
  route: '/task/:taskId/runs/:runId/claim',
  name: 'claimTask',
  stability: APIBuilder.stability.deprecated,
  category: 'Worker Interface',
  scopes: {AnyOf: [
    {AllOf: [
      'queue:claim-task:<provisionerId>/<workerType>',
      'queue:worker-id:<workerGroup>/<workerId>',
    ]},
    {AllOf: [ // Legacy
      'queue:claim-task',
      'assume:worker-type:<provisionerId>/<workerType>',
      'assume:worker-id:<workerGroup>/<workerId>',
    ]},
  ]},
  input: 'task-claim-request.yml',
  output: 'task-claim-response.yml',
  title: 'Claim Task',
  description: [
    'claim a task - never documented',
  ].join('\n'),
}, async function(req, res) {
  let taskId = req.params.taskId;
  let runId = parseInt(req.params.runId, 10);

  let workerGroup = req.body.workerGroup;
  let workerId = req.body.workerId;

  // Load Task entity
  let task = await this.Task.load({taskId}, true);

  // Handle cases where the task doesn't exist
  if (!task) {
    return res.reportError(
      'ResourceNotFound',
      'Task `{{taskId}}` not found. Are you sure it was created?', {
        taskId,
      },
    );
  }

  await req.authorize({
    workerGroup,
    workerId,
    provisionerId: task.provisionerId,
    workerType: task.workerType,
  });

  // Check if task is past deadline
  if (task.deadline.getTime() <= Date.now()) {
    return res.reportError(
      'RequestConflict',
      'Task `{{taskId}}` Can\'t be claimed past its deadline of ' +
      '{{deadline}}.', {
        taskId,
        deadline: task.deadline.toJSON(),
      },
    );
  }

  const worker = await this.Worker.load({
    provisionerId: task.provisionerId,
    workerType: task.workerType,
    workerGroup,
    workerId,
  }, true);

  // Don't record task when worker is quarantined
  if (worker && worker.quarantineUntil.getTime() > new Date().getTime()) {
    return res.reply({});
  }

  // Claim task
  let [result] = await Promise.all([
    this.workClaimer.claimTask(
      taskId, runId, workerGroup, workerId, task,
    ),
    this.workerInfo.seen(task.provisionerId),
  ]);

  // If the run doesn't exist return ResourceNotFound
  if (result === 'run-not-found') {
    return res.reportError(
      'ResourceNotFound',
      'Run {{runId}} not found on task `{{taskId}}`.', {
        taskId,
        runId,
      },
    );
  }

  // If already claimed we return RequestConflict
  if (result === 'conflict') {
    return res.reportError(
      'RequestConflict',
      'Run {{runId}} was already claimed by another worker.', {
        runId,
      },
    );
  }

  await this.workerInfo.taskSeen(task.provisionerId, task.workerType, workerGroup, workerId, [result]);

  // Reply to caller
  return res.reply(result);
});

/** Reclaim a task */
builder.declare({
  method: 'post',
  route: '/task/:taskId/runs/:runId/reclaim',
  name: 'reclaimTask',
  stability: APIBuilder.stability.stable,
  category: 'Worker Interface',
  scopes: {AnyOf: [
    'queue:reclaim-task:<taskId>/<runId>',
    {AllOf: [ // Legacy
      'queue:claim-task',
      'assume:worker-id:<workerGroup>/<workerId>',
    ]},
  ]},
  output: 'task-reclaim-response.yml',
  title: 'Reclaim task',
  description: [
    'Refresh the claim for a specific `runId` for given `taskId`. This updates',
    'the `takenUntil` property and returns a new set of temporary credentials',
    'for performing requests on behalf of the task. These credentials should',
    'be used in-place of the credentials returned by `claimWork`.',
    '',
    'The `reclaimTask` requests serves to:',
    ' * Postpone `takenUntil` preventing the queue from resolving',
    '   `claim-expired`,',
    ' * Refresh temporary credentials used for processing the task, and',
    ' * Abort execution if the task/run have been resolved.',
    '',
    'If the `takenUntil` timestamp is exceeded the queue will resolve the run',
    'as _exception_ with reason `claim-expired`, and proceeded to retry to the',
    'task. This ensures that tasks are retried, even if workers disappear',
    'without warning.',
    '',
    'If the task is resolved, this end-point will return `409` reporting',
    '`RequestConflict`. This typically happens if the task have been canceled',
    'or the `task.deadline` have been exceeded. If reclaiming fails, workers',
    'should abort the task and forget about the given `runId`. There is no',
    'need to resolve the run or upload artifacts.',
  ].join('\n'),
}, async function(req, res) {
  let taskId = req.params.taskId;
  let runId = parseInt(req.params.runId, 10);

  // Load Task entity
  let task = await this.Task.load({taskId}, true);

  // Handle cases where the task doesn't exist
  if (!task) {
    return res.reportError(
      'ResourceNotFound',
      'Task `{{taskId}}` not found. Are you sure it was created?', {
        taskId,
      },
    );
  }

  // Handle cases where the run doesn't exist
  let run = task.runs[runId];
  if (!run) {
    return res.reportError(
      'ResourceNotFound',
      'Run {{runId}} not found on task `{{taskId}}`.', {
        taskId,
        runId,
      },
    );
  }

  await req.authorize({
    taskId,
    runId,
    workerId: run.workerId,
    workerGroup: run.workerGroup,
  });

  // Check if task is past deadline
  if (task.deadline.getTime() <= Date.now()) {
    return res.reportError(
      'RequestConflict',
      'Task `{{taskId}}` Can\'t be reclaimed past its deadline of ' +
      '{{deadline}}.', {
        taskId,
        deadline: task.deadline.toJSON(),
      },
    );
  }

  // Set takenUntil to now + claimTimeout
  let takenUntil = new Date();
  takenUntil.setSeconds(takenUntil.getSeconds() + this.claimTimeout);

  let msgPut = false;
  await task.modify(async (task) => {
    let run = task.runs[runId];

    // No modifications required if there is no run or run isn't running
    if (task.runs.length - 1 !== runId || run.state !== 'running') {
      return;
    }

    // Don't update takenUntil if it's further into the future than the one
    // we're proposing
    if (new Date(run.takenUntil).getTime() >= takenUntil.getTime()) {
      return;
    }

    // Put claim-expiration message in queue, if not already done, remember
    // that the modifier given to task.modify may be called more than once!
    if (!msgPut) {
      await this.queueService.putClaimMessage(taskId, runId, takenUntil);
      msgPut = true;
    }

    // Update takenUntil
    run.takenUntil = takenUntil.toJSON();
    task.takenUntil = takenUntil;
  });

  // Find the run that we (may) have modified
  run = task.runs[runId];

  // If run isn't running we had a conflict
  if (task.runs.length - 1 !== runId || run.state !== 'running') {
    return res.reportError(
      'RequestConflict',
      'Run {{runId}} on task `{{taskId}}` is resolved or not running.', {
        taskId,
        runId,
      },
    );
  }

  let credentials = taskCreds(
    taskId,
    runId,
    run.workerGroup,
    run.workerId,
    takenUntil,
    task.scopes,
    this.credentials,
  );

  this.monitor.log.taskReclaimed({
    taskId,
    runId,
    workerId: run.workerId,
    workerGroup: run.workerGroup,
  });

  // Reply to caller
  return res.reply({
    status: task.status(),
    runId: runId,
    workerGroup: run.workerGroup,
    workerId: run.workerId,
    takenUntil: takenUntil.toJSON(),
    credentials: credentials,
  });
});

/**
 * Resolve a run of a task as `target` ('completed' or 'failed').
 * This function assumes the same context as the API.
 */
let resolveTask = async function(req, res, taskId, runId, target) {
  assert(target === 'completed' ||
         target === 'failed', 'Expected a valid target');

  // Load Task entity
  let task = await this.Task.load({taskId}, true);

  // Handle cases where the task doesn't exist
  if (!task) {
    return res.reportError('ResourceNotFound',
      'Task `{{taskId}}` not found. Are you sure it was created?', {
        taskId,
      },
    );
  }

  // Handle cases where the run doesn't exist
  let run = task.runs[runId];
  if (!run) {
    return res.reportError('ResourceNotFound',
      'Run {{runId}} not found on task `{{taskId}}`.', {
        taskId,
        runId,
      },
    );
  }

  await req.authorize({
    taskId,
    runId,
    workerGroup: run.workerGroup,
    workerId: run.workerId,
  });

  // Ensure that all blob artifacts which were created are present before
  // allowing resolution as 'completed'
  if (target === 'completed') {
    let haveAllBlobs = true;
    await this.Artifact.query({
      taskId,
      runId,
      storageType: 'blob',
      present: false,
    }, {
      limit: 1,
      handler: () => { haveAllBlobs = false; },
    });

    if (!haveAllBlobs) {
      return res.reportError('RequestConflict',
        'All blob artifacts must be present to resolve task as completed');
    }
  }

  await task.modify((task) => {
    let run = task.runs[runId];

    // No modification if run isn't running or the run isn't last
    if (task.runs.length - 1 !== runId || run.state !== 'running') {
      return;
    }

    // Update run
    run.state = target; // completed or failed
    run.reasonResolved = target; // completed or failed
    run.resolved = new Date().toJSON();

    // Clear takenUntil on task
    task.takenUntil = new Date(0);
  });
  // Find the run that we (may) have modified
  run = task.runs[runId];

  // If run isn't resolved to target, we had a conflict
  if (task.runs.length - 1 !== runId ||
      run.state !== target ||
      run.reasonResolved !== target) {
    return res.reportError('RequestConflict',
      'Run {{runId}} on task `{{taskId}}` is resolved or not running.', {
        taskId,
        runId,
      },
    );
  }

  // Update dependency tracker
  await this.queueService.putResolvedMessage(
    taskId,
    task.taskGroupId,
    task.schedulerId,
    target,
  );

  // Construct status object
  let status = task.status();
  let taskPulseContents = {
    tags: task.tags,
  };
  // Post message about task resolution
  if (target === 'completed') {
    await this.publisher.taskCompleted({
      status,
      runId,
      task: taskPulseContents,
      workerGroup: run.workerGroup,
      workerId: run.workerId,
    }, task.routes);
    this.monitor.log.taskCompleted({taskId, runId});
  } else {
    await this.publisher.taskFailed({
      status,
      runId,
      task: taskPulseContents,
      workerGroup: run.workerGroup,
      workerId: run.workerId,
    }, task.routes);
    this.monitor.log.taskFailed({taskId, runId});
  }

  return res.reply({status});
};

/** Report task completed */
builder.declare({
  method: 'post',
  route: '/task/:taskId/runs/:runId/completed',
  name: 'reportCompleted',
  stability: APIBuilder.stability.stable,
  category: 'Worker Interface',
  scopes: {AnyOf: [
    'queue:resolve-task:<taskId>/<runId>',
    {AllOf: [ // Legacy
      'queue:resolve-task',
      'assume:worker-id:<workerGroup>/<workerId>',
    ]},
  ]},
  input: undefined, // No input at this point
  output: 'task-status-response.yml',
  title: 'Report Run Completed',
  description: [
    'Report a task completed, resolving the run as `completed`.',
  ].join('\n'),
}, function(req, res) {
  let taskId = req.params.taskId;
  let runId = parseInt(req.params.runId, 10);
  // Backwards compatibility with very old workers, should be dropped in the
  // future
  let target = req.body.success === false ? 'failed' : 'completed';

  return resolveTask.call(this, req, res, taskId, runId, target);
});

/** Report task failed */
builder.declare({
  method: 'post',
  route: '/task/:taskId/runs/:runId/failed',
  name: 'reportFailed',
  stability: APIBuilder.stability.stable,
  category: 'Worker Interface',
  scopes: {AnyOf: [
    'queue:resolve-task:<taskId>/<runId>',
    {AllOf: [ // Legacy
      'queue:resolve-task',
      'assume:worker-id:<workerGroup>/<workerId>',
    ]},
  ]},
  input: undefined, // No input at this point
  output: 'task-status-response.yml',
  title: 'Report Run Failed',
  description: [
    'Report a run failed, resolving the run as `failed`. Use this to resolve',
    'a run that failed because the task specific code behaved unexpectedly.',
    'For example the task exited non-zero, or didn\'t produce expected output.',
    '',
    'Do not use this if the task couldn\'t be run because if malformed',
    'payload, or other unexpected condition. In these cases we have a task',
    'exception, which should be reported with `reportException`.',
  ].join('\n'),
}, function(req, res) {
  let taskId = req.params.taskId;
  let runId = parseInt(req.params.runId, 10);

  return resolveTask.call(this, req, res, taskId, runId, 'failed');
});

/** Report task exception */
builder.declare({
  method: 'post',
  route: '/task/:taskId/runs/:runId/exception',
  name: 'reportException',
  stability: APIBuilder.stability.stable,
  category: 'Worker Interface',
  scopes: {AnyOf: [
    'queue:resolve-task:<taskId>/<runId>',
    {AllOf: [ // Legacy
      'queue:resolve-task',
      'assume:worker-id:<workerGroup>/<workerId>',
    ]},
  ]},
  input: 'task-exception-request.yml',
  output: 'task-status-response.yml',
  title: 'Report Task Exception',
  description: [
    'Resolve a run as _exception_. Generally, you will want to report tasks as',
    'failed instead of exception. You should `reportException` if,',
    '',
    '  * The `task.payload` is invalid,',
    '  * Non-existent resources are referenced,',
    '  * Declared actions cannot be executed due to unavailable resources,',
    '  * The worker had to shutdown prematurely,',
    '  * The worker experienced an unknown error, or,',
    '  * The task explicitly requested a retry.',
    '',
    'Do not use this to signal that some user-specified code crashed for any',
    'reason specific to this code. If user-specific code hits a resource that',
    'is temporarily unavailable worker should report task _failed_.',
  ].join('\n'),
}, async function(req, res) {
  let taskId = req.params.taskId;
  let runId = parseInt(req.params.runId, 10);
  let reason = req.body.reason;

  // Load Task entity
  let task = await this.Task.load({taskId}, true);

  // Handle cases where the task doesn't exist
  if (!task) {
    return res.reportError('ResourceNotFound',
      'Task `{{taskId}}` not found. Are you sure it exists?', {
        taskId,
      },
    );
  }

  // Handle cases where the run doesn't exist
  let run = task.runs[runId];
  if (!run) {
    return res.reportError(
      'ResourceNotFound',
      'Run {{runId}} not found on task `{{taskId}}`.', {
        taskId,
        runId,
      },
    );
  }

  await req.authorize({
    taskId,
    runId,
    workerGroup: run.workerGroup,
    workerId: run.workerId,
  });

  await task.modify((task) => {
    let run = task.runs[runId];

    // No modification if run isn't running or the run isn't last
    if (task.runs.length - 1 !== runId || run.state !== 'running') {
      return;
    }

    // Update run
    run.state = 'exception';
    run.reasonResolved = reason;
    run.resolved = new Date().toJSON();

    // Clear takenUntil on task
    task.takenUntil = new Date(0);

    // Add retry, if this is a worker-shutdown and we have retries left
    if (reason === 'worker-shutdown' && task.retriesLeft > 0) {
      task.retriesLeft -= 1;
      task.runs.push({
        state: 'pending',
        reasonCreated: 'retry',
        scheduled: new Date().toJSON(),
      });
    }
    // Add task-retry, if this was an intermittent-task and we have retries
    if (reason === 'intermittent-task' && task.retriesLeft > 0) {
      task.retriesLeft -= 1;
      task.runs.push({
        state: 'pending',
        reasonCreated: 'task-retry',
        scheduled: new Date().toJSON(),
      });
    }
  });

  // Find the run that we (may) have modified
  run = task.runs[runId];

  // If run isn't resolved to exception with reason, we had a conflict
  if (!run ||
      task.runs.length - 1 > runId + 1 ||
      run.state !== 'exception' ||
      run.reasonResolved !== reason) {
    return res.reportError('RequestConflict',
      'Run {{runId}} on task `{{taskId}}` is resolved or not running.', {
        taskId,
        runId,
      },
    );
  }

  let status = task.status();
  let taskPulseContents = {
    tags: task.tags,
  };

  // If a newRun was created and it is a retry with state pending then we better
  // publish messages about it. And if we're not retrying the task, because then
  // the task is resolved as it has no more runs, and we publish a message about
  // task-exception.
  let newRun = task.runs[runId + 1];
  if (newRun &&
      task.runs.length - 1 === runId + 1 &&
      newRun.state === 'pending' &&
      (newRun.reasonCreated === 'retry' ||
       newRun.reasonCreated === 'task-retry')) {
    await Promise.all([
      this.queueService.putPendingMessage(task, runId + 1),
      this.publisher.taskPending({
        status,
        task: taskPulseContents,
        runId: runId + 1,
      }, task.routes),
    ]);
    this.monitor.log.taskPending({taskId, runId: runId + 1});
  } else {
    // Update dependency tracker, as the task is resolved (no new run)
    await this.queueService.putResolvedMessage(
      taskId,
      task.taskGroupId,
      task.schedulerId,
      'exception',
    );

    // Publish message about taskException
    await this.publisher.taskException({
      status,
      runId,
      task: taskPulseContents,
      workerGroup: run.workerGroup,
      workerId: run.workerId,
    }, task.routes);
    this.monitor.log.taskException({taskId, runId});
  }

  // Reply to caller
  return res.reply({status});
});

// Load artifacts.js so API end-points declared in that file is loaded
require('./artifacts');

/** Get all active provisioners */
builder.declare({
  method: 'get',
  route: '/provisioners',
  query: {
    continuationToken: Entity.continuationTokenPattern,
    limit: /^[0-9]+$/,
  },
  name: 'listProvisioners',
  category: 'Worker Metadata',
  stability: APIBuilder.stability.experimental,
  output: 'list-provisioners-response.yml',
  title: 'Get a list of all active provisioners',
  description: [
    'Get all active provisioners.',
    '',
    'The term "provisioner" is taken broadly to mean anything with a provisionerId.',
    'This does not necessarily mean there is an associated service performing any',
    'provisioning activity.',
    '',
    'The response is paged. If this end-point returns a `continuationToken`, you',
    'should call the end-point again with the `continuationToken` as a query-string',
    'option. By default this end-point will list up to 1000 provisioners in a single',
    'page. You may limit this with the query-string parameter `limit`.',
  ].join('\n'),
}, async function(req, res) {
  const continuation = req.query.continuationToken || null;
  const limit = Math.min(1000, parseInt(req.query.limit || 1000, 10));

  const provisioners = await this.Provisioner.scan({}, {continuation, limit});
  const result = {
    provisioners: provisioners.entries.map(provisioner => provisioner.json()),
  };

  if (provisioners.continuation) {
    result.continuationToken = provisioners.continuation;
  }

  return res.reply(result);
});

/** Get a provisioner */
builder.declare({
  method: 'get',
  route: '/provisioners/:provisionerId',
  name: 'getProvisioner',
  stability: APIBuilder.stability.experimental,
  output: 'provisioner-response.yml',
  category: 'Worker Metadata',
  title: 'Get an active provisioner',
  description: [
    'Get an active provisioner.',
    '',
    'The term "provisioner" is taken broadly to mean anything with a provisionerId.',
    'This does not necessarily mean there is an associated service performing any',
    'provisioning activity.',
  ].join('\n'),
}, async function(req, res) {
  const provisionerId = req.params.provisionerId;

  const provisioner = await this.Provisioner.load({
    provisionerId,
    expires: Entity.op.greaterThan(new Date()),
  }, true);

  if (!provisioner) {
    return res.reportError('ResourceNotFound',
      'Provisioner `{{provisionerId}}` not found. Are you sure it was created?', {
        provisionerId,
      },
    );
  }

  return res.reply(provisioner.json());
});

/** Update a provisioner */
builder.declare({
  method: 'put',
  route: '/provisioners/:provisionerId',
  name: 'declareProvisioner',
  stability: APIBuilder.stability.experimental,
  category: 'Worker Metadata',
  scopes: {AllOf: [{
    for: 'property',
    in: 'properties',
    each: 'queue:declare-provisioner:<provisionerId>#<property>',
  }]},
  output: 'provisioner-response.yml',
  input: 'update-provisioner-request.yml',
  title: 'Update a provisioner',
  description: [
    'Declare a provisioner, supplying some details about it.',
    '',
    '`declareProvisioner` allows updating one or more properties of a provisioner as long as the required scopes are',
    'possessed. For example, a request to update the `my-provisioner`',
    'provisioner with a body `{description: \'This provisioner is great\'}` would require you to have the scope',
    '`queue:declare-provisioner:my-provisioner#description`.',
    '',
    'The term "provisioner" is taken broadly to mean anything with a provisionerId.',
    'This does not necessarily mean there is an associated service performing any',
    'provisioning activity.',
  ].join('\n'),
}, async function(req, res) {
  const provisionerId = req.params.provisionerId;
  const {stability, description, expires, actions} = req.body;

  await req.authorize({
    provisionerId,
    properties: Object.keys(req.body),
  });

  const provisioner = await this.workerInfo.upsertProvisioner({
    provisionerId,
    stability,
    description,
    expires,
    actions,
  });

  return res.reply(provisioner.json());
});

/** Count pending tasks for workerType */
builder.declare({
  method: 'get',
  route: '/pending/:provisionerId/:workerType',
  name: 'pendingTasks',
  stability: APIBuilder.stability.stable,
  category: 'Worker Metadata',
  output: 'pending-tasks-response.yml',
  title: 'Get Number of Pending Tasks',
  description: [
    'Get an approximate number of pending tasks for the given `provisionerId`',
    'and `workerType`.',
    '',
    'The underlying Azure Storage Queues only promises to give us an estimate.',
    'Furthermore, we cache the result in memory for 20 seconds. So consumers',
    'should be no means expect this to be an accurate number.',
    'It is, however, a solid estimate of the number of pending tasks.',
  ].join('\n'),
}, async function(req, res) {
  let provisionerId = req.params.provisionerId;
  let workerType = req.params.workerType;

  // Get number of pending message
  let count = await this.queueService.countPendingMessages(
    provisionerId, workerType,
  );

  // Reply to call with count `pendingTasks`
  return res.reply({
    provisionerId: provisionerId,
    workerType: workerType,
    pendingTasks: count,
  });
});

/** List worker-types for a given provisioner */
builder.declare({
  method: 'get',
  route: '/provisioners/:provisionerId/worker-types',
  query: {
    continuationToken: Entity.continuationTokenPattern,
    limit: /^[0-9]+$/,
  },
  name: 'listWorkerTypes',
  category: 'Worker Metadata',
  stability: APIBuilder.stability.experimental,
  output: 'list-workertypes-response.yml',
  title: 'Get a list of all active worker-types',
  description: [
    'Get all active worker-types for the given provisioner.',
    '',
    'The response is paged. If this end-point returns a `continuationToken`, you',
    'should call the end-point again with the `continuationToken` as a query-string',
    'option. By default this end-point will list up to 1000 worker-types in a single',
    'page. You may limit this with the query-string parameter `limit`.',
  ].join('\n'),
}, async function(req, res) {
  const continuation = req.query.continuationToken || null;
  const provisionerId = req.params.provisionerId;
  const limit = Math.min(1000, parseInt(req.query.limit || 1000, 10));

  const workerTypes = await this.WorkerType.scan({provisionerId}, {continuation, limit});

  const result = {
    workerTypes: workerTypes.entries.map(workerType => workerType.json()),
  };

  if (workerTypes.continuation) {
    result.continuationToken = workerTypes.continuation;
  }

  return res.reply(result);
});

/** Get a worker-type from a provisioner */
builder.declare({
  method: 'get',
  route: '/provisioners/:provisionerId/worker-types/:workerType',
  name: 'getWorkerType',
  stability: APIBuilder.stability.experimental,
  category: 'Worker Metadata',
  output: 'workertype-response.yml',
  title: 'Get a worker-type',
  description: [
    'Get a worker-type from a provisioner.',
  ].join('\n'),
}, async function(req, res) {
  const {provisionerId, workerType} = req.params;

  const [wType, provisioner] = await Promise.all([
    this.WorkerType.load({
      provisionerId,
      workerType,
      expires: Entity.op.greaterThan(new Date()),
    }, true),
    this.Provisioner.load({provisionerId}, true),
  ]);

  if (!wType || !provisioner) {
    return res.reportError('ResourceNotFound',
      'Worker-type `{{workerType}}` with Provisioner `{{provisionerId}}` not found. Are you sure it was created?', {
        workerType,
        provisionerId,
      },
    );
  }

  const actions = provisioner.actions.filter(action => action.context === 'worker-type');
  return res.reply(Object.assign({}, wType.json(), {actions}));
});

/** Update a worker-type */
builder.declare({
  method: 'put',
  route: '/provisioners/:provisionerId/worker-types/:workerType',
  name: 'declareWorkerType',
  stability: APIBuilder.stability.experimental,
  category: 'Worker Metadata',
  scopes: {AllOf: [
    {
      for: 'property',
      in: 'properties',
      each: 'queue:declare-worker-type:<provisionerId>/<workerType>#<property>',
    },
  ]},
  output: 'workertype-response.yml',
  input: 'update-workertype-request.yml',
  title: 'Update a worker-type',
  description: [
    'Declare a workerType, supplying some details about it.',
    '',
    '`declareWorkerType` allows updating one or more properties of a worker-type as long as the required scopes are',
    'possessed. For example, a request to update the `highmem` worker-type within the `my-provisioner`',
    'provisioner with a body `{description: \'This worker type is great\'}` would require you to have the scope',
    '`queue:declare-worker-type:my-provisioner/highmem#description`.',
  ].join('\n'),
}, async function(req, res) {
  const {provisionerId, workerType} = req.params;
  const {stability, description, expires} = req.body;

  await req.authorize({
    provisionerId,
    workerType,
    properties: Object.keys(req.body),
  });

  const [wType, provisioner] = await Promise.all([
    this.workerInfo.upsertWorkerType({
      provisionerId,
      workerType,
      stability,
      description,
      expires,
    }),
    this.workerInfo.upsertProvisioner({provisionerId}),
  ]);

  const actions = provisioner.actions.filter(action => action.context === 'worker-type');
  return res.reply(Object.assign({}, wType.json(), {actions}));
});

/** List all active workerGroup/workerId of a workerType */
builder.declare({
  method: 'get',
  route: '/provisioners/:provisionerId/worker-types/:workerType/workers',
  query: {
    continuationToken: Entity.continuationTokenPattern,
    limit: /^[0-9]+$/,
    quarantined: /^(true|false)$/,
  },
  name: 'listWorkers',
  stability: APIBuilder.stability.experimental,
  category: 'Worker Metadata',
  output: 'list-workers-response.yml',
  title: 'Get a list of all active workers of a workerType',
  description: [
    'Get a list of all active workers of a workerType.',
    '',
    '`listWorkers` allows a response to be filtered by quarantined and non quarantined workers.',
    'To filter the query, you should call the end-point with `quarantined` as a query-string option with a',
    'true or false value.',
    '',
    'The response is paged. If this end-point returns a `continuationToken`, you',
    'should call the end-point again with the `continuationToken` as a query-string',
    'option. By default this end-point will list up to 1000 workers in a single',
    'page. You may limit this with the query-string parameter `limit`.',
  ].join('\n'),
}, async function(req, res) {
  const continuation = req.query.continuationToken || null;
  const quarantined = req.query.quarantined || null;
  const provisionerId = req.params.provisionerId;
  const workerType = req.params.workerType;
  const limit = Math.min(1000, parseInt(req.query.limit || 1000, 10));
  const now = new Date();

  const workerQuery = {
    provisionerId,
    workerType,
  };

  if (quarantined === 'true') {
    workerQuery.quarantineUntil = Entity.op.greaterThan(now);
  } else if (quarantined === 'false') {
    workerQuery.quarantineUntil = Entity.op.lessThan(now);
  }

  const workers = await this.Worker.scan(workerQuery, {continuation, limit});

  const result = {
    workers: workers.entries.filter(worker => {
      // filter out anything that is both expired and not quarantined,
      // so that quarantined workers remain visible even after expiration
      return worker.expires >= now || worker.quarantineUntil >= now;
    }).map(worker => {
      let entry = {
        workerGroup: worker.workerGroup,
        workerId: worker.workerId,
        firstClaim: worker.firstClaim.toJSON(),
      };
      if (worker.recentTasks.length > 0) {
        entry.latestTask = worker.recentTasks[worker.recentTasks.length - 1];
      }
      if (worker.quarantineUntil.getTime() > now.getTime()) {
        entry.quarantineUntil = worker.quarantineUntil.toJSON();
      }
      return entry;
    }),
  };

  if (workers.continuation) {
    result.continuationToken = workers.continuation;
  }

  return res.reply(result);
});

/** Get a worker from a worker-type */
builder.declare({
  method: 'get',
  route: '/provisioners/:provisionerId/worker-types/:workerType/workers/:workerGroup/:workerId',
  name: 'getWorker',
  stability: APIBuilder.stability.experimental,
  output: 'worker-response.yml',
  title: 'Get a worker-type',
  category: 'Worker Metadata',
  description: [
    'Get a worker from a worker-type.',
  ].join('\n'),
}, async function(req, res) {
  const {provisionerId, workerType, workerGroup, workerId} = req.params;

  const [worker, wType, provisioner] = await Promise.all([
    this.Worker.load({
      provisionerId,
      workerType,
      workerGroup,
      workerId,
    }, true),
    this.WorkerType.load({provisionerId, workerType}, true),
    this.Provisioner.load({provisionerId}, true),
  ]);

  // do not consider workers expired until their quarantine date expires.
  const now = new Date();
  const expired = worker && worker.expires < now && worker.quarantineUntil < now;

  if (expired || !worker || !wType || !provisioner) {
    return res.reportError('ResourceNotFound',
      'Worker with workerId `{{workerId}}`, workerGroup `{{workerGroup}}`,' +
      'worker-type `{{workerType}}` and provisionerId `{{provisionerId}}` not found. ' +
      'Are you sure it was created?', {
        workerId,
        workerGroup,
        workerType,
        provisionerId,
      },
    );
  }

  const actions = provisioner.actions.filter(action => action.context === 'worker');
  return res.reply(Object.assign({}, worker.json(), {actions}));
});

/** Quarantine a Worker */
builder.declare({
  method: 'put',
  route: '/provisioners/:provisionerId/worker-types/:workerType/workers/:workerGroup/:workerId',
  name: 'quarantineWorker',
  stability: APIBuilder.stability.experimental,
  category: 'Worker Metadata',
  scopes: {AllOf: [
    'queue:quarantine-worker:<provisionerId>/<workerType>/<workerGroup>/<workerId>',
  ]},
  input: 'quarantine-worker-request.yml',
  output: 'worker-response.yml',
  title: 'Quarantine a worker',
  description: [
    'Quarantine a worker',
  ].join('\n'),
}, async function(req, res) {
  let result;
  const {provisionerId, workerType, workerGroup, workerId} = req.params;
  const {quarantineUntil} = req.body;
  const [worker, provisioner] = await Promise.all([
    this.Worker.load({provisionerId, workerType, workerGroup, workerId}, true),
    this.Provisioner.load({provisionerId}, true),
  ]);

  if (!worker) {
    return res.reportError('ResourceNotFound',
      'Worker with workerId `{{workerId}}`, workerGroup `{{workerGroup}}`,' +
      'worker-type `{{workerType}}` and provisionerId `{{provisionerId}}` not found. ' +
      'Are you sure it was created?', {
        workerId,
        workerGroup,
        workerType,
        provisionerId,
      },
    );
  }

  result = await worker.modify((entity) => {
    entity.quarantineUntil = new Date(quarantineUntil);
  });

  const actions = provisioner.actions.filter(action => action.context === 'worker');
  return res.reply(Object.assign({}, result.json(), {actions}));
});

/** Update a worker */
builder.declare({
  method: 'put',
  route: '/provisioners/:provisionerId/worker-types/:workerType/:workerGroup/:workerId',
  name: 'declareWorker',
  stability: APIBuilder.stability.experimental,
  category: 'Worker Metadata',
  scopes: {AllOf: [
    {
      for: 'property',
      in: 'properties',
      each: 'queue:declare-worker:<provisionerId>/<workerType>/<workerGroup>/<workerId>#<property>',
    },
  ]},
  output: 'worker-response.yml',
  input: 'update-worker-request.yml',
  title: 'Declare a worker',
  description: [
    'Declare a worker, supplying some details about it.',
    '',
    '`declareWorker` allows updating one or more properties of a worker as long as the required scopes are',
    'possessed.',
  ].join('\n'),
}, async function(req, res) {
  const {provisionerId, workerType, workerGroup, workerId} = req.params;
  const {expires} = req.body;

  await req.authorize({
    provisionerId,
    workerType,
    workerGroup,
    workerId,
    properties: Object.keys(req.body),
  });

  const [worker, _, provisioner] = await Promise.all([
    this.workerInfo.upsertWorker({provisionerId, workerType, workerGroup, workerId, expires}),
    this.workerInfo.upsertWorkerType({provisionerId, workerType}),
    this.workerInfo.upsertProvisioner({provisionerId}),
  ]);

  const actions = provisioner.actions.filter(action => action.context === 'worker');
  return res.reply(Object.assign({}, worker.json(), {actions}));
});
