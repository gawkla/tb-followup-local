# Follow-up Local v0.1.26 — Reschedule

**Follow-up reminders and reply tracking for Thunderbird Local Folders.**

What's new:
- Update an existing follow-up deadline instead of receiving a duplicate-task error.
- Click **Reschedule** in the Active queue or reopen Follow-up on the original message.
- A task in Reminded returns to Waiting when rescheduled while keeping its original task ID.
- Existing reminder emails are not deleted; a new one is generated at the new deadline, not at rescheduling time.

Also includes local threaded reminders, optional original-message movement, reply tracking, tags, notifications, and a searchable queue.

**Compatibility:** Thunderbird 140+, **Local Folders only** (no IMAP/POP folder monitoring). No SMTP messages are sent by the reminder mechanism.

**Installation:** download the attached `followup-local-v0.1.26.xpi` and install via Thunderbird Add-ons and Themes.

**Important for users of the original local development build:** this publishing release has a **different add-on ID and separate task storage**. It does not migrate your existing Follow-up database.
