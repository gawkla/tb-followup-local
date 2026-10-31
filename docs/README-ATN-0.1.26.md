# Follow-up Local 0.1.26 — Thunderbird Add-ons publication branch

This is the ATN publishing build, derived directly from the user-tested 0.1.26 Reschedule release.

The **only difference in the installable XPI is `manifest.json`**:
- `applications` becomes `browser_specific_settings` (Manifest V2 compatible).
- `gecko.id` is `gawkla.followup-local@addons.thunderbird.net`, matching the previously prepared ATN 0.1.25 branch.

No UI, background logic, storage structure, permissions, schedules, message operations, or other extension files are modified.

## How to submit

Upload `Followup-Local-0.1.26-ATN-PUBLISH.xpi` as version **0.1.26** of the existing Follow-up Local listing on addons.thunderbird.net. Do **not** create a second listing with a different ID.

This ATN branch has a different ID from the locally installed 0.1.26 (`snooze-followup-local@chatgpt.example`) and therefore uses independent extension storage. Do not install it over your daily-use local build expecting it to keep local follow-up records.

## Functional release notes (English)

- Reschedule an existing active follow-up directly from a selected message, instead of triggering a duplicate follow-up error.
- Reschedule active tasks from the follow-up list using a new **Reschedule** button.
- Rescheduling an overdue/reminded task returns it to Waiting, retains the task record and reply tracking, and schedules a new reminder for the new due date.
- Already generated local reminder messages are retained; no duplicate is created at the moment of rescheduling.

## QA

The source package includes integration tests. JavaScript syntax, archive integrity, and byte-for-byte parity of every non-manifest XPI file were checked. No live Thunderbird install test was performed by the packager.
