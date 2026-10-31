# Follow-up Local 0.1.26 — reschedule an existing follow-up

Based on tested 0.1.25. This is an in-place update with the **same extension ID** (`snooze-followup-local@chatgpt.example`) and the same local task database.

## Change
- Selecting an email with an existing active follow-up shows the current status/date and **Update existing follow-up and close** rather than an error about a duplicate.
- The existing due date is prefilled; change it with the presets or date/time fields.
- The Active list has a **Reschedule** button on waiting, reminded, and error follow-ups; it can be used without selecting the email.
- When a REMINDED follow-up is rescheduled, its original task ID and message tracking are preserved; its status returns to WAITING. Reminder/WaitingForFBK tags are restored on the monitored original where possible.
- Previously generated local reminder messages are **not deleted**. On the newly chosen due date, the add-on can create a new local reminder with a unique Message-ID to bring the thread back to the Inbox top; this is not generated at the moment of rescheduling.
- Tasks currently being processed, already answered, or completed cannot be rescheduled by this operation.
- No changes to the compose action, single-window behavior, other reminder operations or storage schema migration.

## Installation
Install directly over Follow-up Local 0.1.25. Do **not** uninstall the earlier add-on, or you may lose its local data. Test on one unimportant existing follow-up first.

## Validation
Static JS syntax check + Node VM integration test of selected-message update, reminded->waiting, tag restoration, list update, no duplicate task/reminder at update, and status protections. Not tested in a live Thunderbird process.
