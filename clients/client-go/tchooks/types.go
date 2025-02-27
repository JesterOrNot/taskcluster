// This source code file is AUTO-GENERATED by github.com/taskcluster/jsonschema2go

package tchooks

import (
	"encoding/json"
	"errors"

	tcclient "github.com/taskcluster/taskcluster/clients/client-go/v23"
)

type (
	// Exchange and RoutingKeyPattern for each binding
	Binding struct {

		// Min length: 1
		Exchange string `json:"exchange"`

		// Min length: 1
		RoutingKeyPattern string `json:"routingKeyPattern"`
	}

	// Information about an unsuccessful firing of the hook
	FailedFire struct {

		// The error that occurred when firing the task.  This is typically,
		// but not always, an API error message.
		//
		// Additional properties allowed
		Error json.RawMessage `json:"error"`

		// Possible values:
		//   * "error"
		Result string `json:"result"`

		// The time the task was created.  This will not necessarily match `task.created`.
		Time tcclient.Time `json:"time"`
	}

	// Definition of a hook that can create tasks at defined times.
	HookCreationRequest struct {
		Bindings []Binding `json:"bindings,omitempty"`

		// Syntax:     ^([a-zA-Z0-9-_]*)$
		// Min length: 1
		// Max length: 64
		HookGroupID string `json:"hookGroupId,omitempty"`

		// Syntax:     ^([a-zA-Z0-9-_/]*)$
		// Min length: 1
		// Max length: 64
		HookID string `json:"hookId,omitempty"`

		Metadata HookMetadata `json:"metadata"`

		// Definition of the times at which a hook will result in creation of a task.
		// If several patterns are specified, tasks will be created at any time
		// specified by one or more patterns.
		//
		// Default:    []
		//
		// Array items:
		// Cron-like specification for when tasks should be created.  The pattern is
		// parsed in a UTC context.
		// See [cron-parser on npm](https://www.npmjs.com/package/cron-parser).
		// Note that tasks may not be created at exactly the time specified.
		Schedule []string `json:"schedule,omitempty"`

		// Template for the task definition.  This is rendered using [JSON-e](https://taskcluster.github.io/json-e/)
		// as described in [firing hooks](/docs/reference/core/hooks/firing-hooks) to produce
		// a task definition that is submitted to the Queue service.
		//
		// Additional properties allowed
		Task json.RawMessage `json:"task"`

		// Default:    {
		//               "additionalProperties": false,
		//               "type": "object"
		//             }
		//
		// Additional properties allowed
		TriggerSchema json.RawMessage `json:"triggerSchema,omitempty"`
	}

	// Definition of a hook that will create tasks when defined events occur.
	HookDefinition struct {
		Bindings []Binding `json:"bindings,omitempty"`

		// Syntax:     ^([a-zA-Z0-9-_]*)$
		// Min length: 1
		// Max length: 64
		HookGroupID string `json:"hookGroupId"`

		// Syntax:     ^([a-zA-Z0-9-_/]*)$
		// Min length: 1
		// Max length: 64
		HookID string `json:"hookId"`

		Metadata HookMetadata `json:"metadata"`

		// A list of cron-style definitions to represent a set of moments in (UTC) time.
		// If several patterns are specified, a given moment in time represented by
		// more than one pattern is considered only to be counted once, in other words
		// it is allowed for the cron patterns to overlap; duplicates are redundant.
		//
		// Default:    []
		//
		// Array items:
		// Cron-like specification for when tasks should be created.  The pattern is
		// parsed in a UTC context.
		// See [cron-parser on npm](https://www.npmjs.com/package/cron-parser).
		Schedule []string `json:"schedule"`

		// Template for the task definition.  This is rendered using [JSON-e](https://taskcluster.github.io/json-e/)
		// as described in [firing hooks](/docs/reference/core/hooks/firing-hooks) to produce
		// a task definition that is submitted to the Queue service.
		//
		// Additional properties allowed
		Task json.RawMessage `json:"task"`

		// Additional properties allowed
		TriggerSchema json.RawMessage `json:"triggerSchema"`
	}

	// List of `hookGroupIds`.
	HookGroups struct {

		// Array items:
		Groups []string `json:"groups"`
	}

	// List of hooks
	HookList struct {
		Hooks []HookDefinition `json:"hooks"`
	}

	HookMetadata struct {

		// Long-form of the hook's purpose and behavior
		//
		// Max length: 32768
		Description string `json:"description"`

		// Whether to email the owner on an error creating the task.
		//
		// Default:    true
		EmailOnError bool `json:"emailOnError,omitempty"`

		// Human readable name of the hook
		//
		// Max length: 255
		Name string `json:"name"`

		// Email of the person or group responsible for this hook.
		//
		// Max length: 255
		Owner string `json:"owner"`
	}

	// A snapshot of the current status of a hook.
	HookStatusResponse struct {

		// Information about the last time this hook fired.  This property is only present
		// if the hook has fired at least once.
		//
		// One of:
		//   * SuccessfulFire
		//   * FailedFire
		//   * NoFire
		LastFire json.RawMessage `json:"lastFire"`

		// The next time this hook's task is scheduled to be created. This property
		// is only present if there is a scheduled next time. Some hooks don't have
		// any schedules.
		NextScheduledDate tcclient.Time `json:"nextScheduledDate,omitempty"`
	}

	// List of lastFires
	LastFiresList struct {
		LastFires []Var `json:"lastFires"`
	}

	// Information about no firing of the hook (e.g., a new hook)
	NoFire struct {

		// Possible values:
		//   * "no-fire"
		Result string `json:"result"`
	}

	// JSON object with information about a run
	RunInformation struct {

		// Reason for the creation of this run,
		// **more reasons may be added in the future**.
		//
		// Possible values:
		//   * "scheduled"
		//   * "retry"
		//   * "task-retry"
		//   * "rerun"
		//   * "exception"
		ReasonCreated string `json:"reasonCreated"`

		// Reason that run was resolved, this is mainly
		// useful for runs resolved as `exception`.
		// Note, **more reasons may be added in the future**, also this
		// property is only available after the run is resolved.
		//
		// Possible values:
		//   * "completed"
		//   * "failed"
		//   * "deadline-exceeded"
		//   * "canceled"
		//   * "superseded"
		//   * "claim-expired"
		//   * "worker-shutdown"
		//   * "malformed-payload"
		//   * "resource-unavailable"
		//   * "internal-error"
		//   * "intermittent-task"
		ReasonResolved string `json:"reasonResolved,omitempty"`

		// Date-time at which this run was resolved, ie. when the run changed
		// state from `running` to either `completed`, `failed` or `exception`.
		// This property is only present after the run as been resolved.
		Resolved tcclient.Time `json:"resolved,omitempty"`

		// Id of this task run, `run-id`s always starts from `0`
		//
		// Mininum:    0
		// Maximum:    1000
		RunID int64 `json:"runId"`

		// Date-time at which this run was scheduled, ie. when the run was
		// created in state `pending`.
		Scheduled tcclient.Time `json:"scheduled"`

		// Date-time at which this run was claimed, ie. when the run changed
		// state from `pending` to `running`. This property is only present
		// after the run has been claimed.
		Started tcclient.Time `json:"started,omitempty"`

		// State of this run
		//
		// Possible values:
		//   * "pending"
		//   * "running"
		//   * "completed"
		//   * "failed"
		//   * "exception"
		State string `json:"state"`

		// Time at which the run expires and is resolved as `failed`, if the
		// run isn't reclaimed. Note, only present after the run has been
		// claimed.
		TakenUntil tcclient.Time `json:"takenUntil,omitempty"`

		// Identifier for group that worker who executes this run is a part of,
		// this identifier is mainly used for efficient routing.
		// Note, this property is only present after the run is claimed.
		//
		// Syntax:     ^([a-zA-Z0-9-_]*)$
		// Min length: 1
		// Max length: 38
		WorkerGroup string `json:"workerGroup,omitempty"`

		// Identifier for worker evaluating this run within given
		// `workerGroup`. Note, this property is only available after the run
		// has been claimed.
		//
		// Syntax:     ^([a-zA-Z0-9-_]*)$
		// Min length: 1
		// Max length: 38
		WorkerID string `json:"workerId,omitempty"`
	}

	Status struct {

		// Deadline of the task, `pending` and `running` runs are
		// resolved as **exception** if not resolved by other means
		// before the deadline. Note, deadline cannot be more than
		// 5 days into the future
		Deadline tcclient.Time `json:"deadline"`

		// Task expiration, time at which task definition and
		// status is deleted. Notice that all artifacts for the task
		// must have an expiration that is no later than this.
		Expires tcclient.Time `json:"expires"`

		// Unique identifier for the provisioner that this task must be scheduled on
		//
		// Syntax:     ^([a-zA-Z0-9-_]*)$
		// Min length: 1
		// Max length: 38
		ProvisionerID string `json:"provisionerId"`

		// Number of retries left for the task in case of infrastructure issues
		//
		// Mininum:    0
		// Maximum:    999
		RetriesLeft int64 `json:"retriesLeft"`

		// List of runs, ordered so that index `i` has `runId == i`
		Runs []RunInformation `json:"runs"`

		// Identifier for the scheduler that _defined_ this task.
		//
		// Syntax:     ^([a-zA-Z0-9-_]*)$
		// Min length: 1
		// Max length: 38
		SchedulerID string `json:"schedulerId"`

		// State of this task. This is just an auxiliary property derived from state
		// of latests run, or `unscheduled` if none.
		//
		// Possible values:
		//   * "unscheduled"
		//   * "pending"
		//   * "running"
		//   * "completed"
		//   * "failed"
		//   * "exception"
		State string `json:"state"`

		// Identifier for a group of tasks scheduled together with this task, by
		// scheduler identified by `schedulerId`. For tasks scheduled by the
		// task-graph scheduler, this is the `taskGraphId`.
		//
		// Syntax:     ^[A-Za-z0-9_-]{8}[Q-T][A-Za-z0-9_-][CGKOSWaeimquy26-][A-Za-z0-9_-]{10}[AQgw]$
		TaskGroupID string `json:"taskGroupId"`

		// Unique task identifier, this is UUID encoded as
		// [URL-safe base64](http://tools.ietf.org/html/rfc4648#section-5) and
		// stripped of `=` padding.
		//
		// Syntax:     ^[A-Za-z0-9_-]{8}[Q-T][A-Za-z0-9_-][CGKOSWaeimquy26-][A-Za-z0-9_-]{10}[AQgw]$
		TaskID string `json:"taskId"`

		// Identifier for worker type within the specified provisioner
		//
		// Syntax:     ^([a-zA-Z0-9-_]*)$
		// Min length: 1
		// Max length: 38
		WorkerType string `json:"workerType"`
	}

	// Information about a successful firing of the hook
	SuccessfulFire struct {

		// Possible values:
		//   * "success"
		Result string `json:"result"`

		// The task created
		//
		// Syntax:     ^[A-Za-z0-9_-]{8}[Q-T][A-Za-z0-9_-][CGKOSWaeimquy26-][A-Za-z0-9_-]{10}[AQgw]$
		TaskID string `json:"taskId"`

		// The time the task was created.  This will not necessarily match `task.created`.
		Time tcclient.Time `json:"time"`
	}

	// A representation of **task status** as known by the queue
	TaskStatusStructure struct {
		Status Status `json:"status"`
	}

	// A request to trigger a hook.  The payload must be a JSON object, and is used as the context
	// for a JSON-e rendering of the hook's task template, as described in "Firing Hooks".
	//
	// Additional properties allowed
	TriggerHookRequest json.RawMessage

	// Response to a `triggerHook` or `triggerHookWithToken` call.
	//
	// In most cases, this is a task status, but in cases where the hook template
	// does not generate a task, it is an empty object with no `status` property.
	//
	// Any of:
	//   * TaskStatusStructure
	//   * TriggerHookResponse1
	TriggerHookResponse json.RawMessage

	// Empty response indicating no task was created
	TriggerHookResponse1 struct {
	}

	// Secret token for a trigger
	TriggerTokenResponse struct {
		Token string `json:"token"`
	}

	Var struct {

		// The error that occurred when firing the task. This is typically,
		// but not always, an API error message.
		Error string `json:"error"`

		// Possible values:
		//   * "schedule"
		//   * "triggerHook"
		//   * "triggerHookWithToken"
		//   * "pulseMessage"
		FiredBy string `json:"firedBy"`

		// Syntax:     ^([a-zA-Z0-9-_]*)$
		// Min length: 1
		// Max length: 64
		HookGroupID string `json:"hookGroupId"`

		// Syntax:     ^([a-zA-Z0-9-_/]*)$
		// Min length: 1
		// Max length: 64
		HookID string `json:"hookId"`

		// Information about success or failure of firing of the hook
		//
		// Possible values:
		//   * "success"
		//   * "error"
		Result string `json:"result"`

		// Time when the task was created
		TaskCreateTime tcclient.Time `json:"taskCreateTime"`

		// Unique task identifier, this is UUID encoded as
		// [URL-safe base64](http://tools.ietf.org/html/rfc4648#section-5) and
		// stripped of `=` padding.
		//
		// Syntax:     ^[A-Za-z0-9_-]{8}[Q-T][A-Za-z0-9_-][CGKOSWaeimquy26-][A-Za-z0-9_-]{10}[AQgw]$
		TaskID string `json:"taskId"`
	}
)

// MarshalJSON calls json.RawMessage method of the same name. Required since
// TriggerHookRequest is of type json.RawMessage...
func (this *TriggerHookRequest) MarshalJSON() ([]byte, error) {
	x := json.RawMessage(*this)
	return (&x).MarshalJSON()
}

// UnmarshalJSON is a copy of the json.RawMessage implementation.
func (this *TriggerHookRequest) UnmarshalJSON(data []byte) error {
	if this == nil {
		return errors.New("TriggerHookRequest: UnmarshalJSON on nil pointer")
	}
	*this = append((*this)[0:0], data...)
	return nil
}

// MarshalJSON calls json.RawMessage method of the same name. Required since
// TriggerHookResponse is of type json.RawMessage...
func (this *TriggerHookResponse) MarshalJSON() ([]byte, error) {
	x := json.RawMessage(*this)
	return (&x).MarshalJSON()
}

// UnmarshalJSON is a copy of the json.RawMessage implementation.
func (this *TriggerHookResponse) UnmarshalJSON(data []byte) error {
	if this == nil {
		return errors.New("TriggerHookResponse: UnmarshalJSON on nil pointer")
	}
	*this = append((*this)[0:0], data...)
	return nil
}
