# Follow-up Local

**Track replies and schedule local, conversation-linked follow-up reminders in Thunderbird Local Folders.**

Unlike a conventional snooze action, Follow-up Local watches a message in its current Local Folders subfolder while waiting for a response. If a reply arrives, the task can be marked answered automatically. If the deadline passes, the extension generates a **local-only reminder email** connected to the original thread, so the conversation can return to the top of the Inbox in threaded, newest-first views.

## Features

- Follow messages within deeply nested **Local Folders**, without moving them immediately.
- Detect replies using email message references and mark follow-ups answered.
- Generate reminder messages **locally**, using Thunderbird's Local Folders. **No reminder is sent by SMTP.**
- Optionally move the **original** message to Local Folders Inbox when the deadline is reached, rather than copying it.
- Quick deadlines: **+1 / +3 / +7 / +21 days** and custom due dates/times.
- Automatically manage follow-up tags, preserve unrelated tags, and show desktop notifications.
- Searchable queue with **Active / Answered / Finished**, overdue highlighting, and an icon warning for overdue items.
- Open the original message from the queue, even after it moves between local folders.
- **Reschedule** an existing active follow-up without creating a duplicate record. A previously reminded task returns to Waiting with the same task ID.
- Keep one Follow-up window: existing windows are focused instead of opening duplicates.
- Optional [Ko-fi](https://ko-fi.com/gawkla) support link in the add-on interface.

## How rescheduling works (v0.1.26)

Choose a message with an existing active follow-up or click **Reschedule** in the Active queue. The current follow-up is updated to the new deadline. Already generated local reminder emails **remain in Thunderbird**; a new reminder is generated only when the updated deadline becomes due.

## Compatibility and limitations

- Thunderbird **140.0+** as declared by the manifest (not tested on every release).
- **Local Folders only**; IMAP and POP folder monitoring are not supported.
- The behavior that raises a conversation to the top depends on Thunderbird's threaded view and sort order.
- Access to messages, folders, tags and locally imported reminder messages is required for these features.

## Installation

1. Visit **Releases** in this repository and download `followup-local-v0.1.26.xpi`.
2. In Thunderbird, open **Add-ons and Themes → Install Add-on From File** and select the XPI.
3. Select a nonessential message stored under Local Folders, create a Follow-up, then test **Reschedule**.

**Existing local-build users:** this GitHub/ATN build has extension ID `gawkla.followup-local@addons.thunderbird.net`. The original development build uses `snooze-followup-local@chatgpt.example`. **They have separate storage**; installing the publishing build does not migrate existing follow-up tasks. Keep using the local build if you need its existing task list.

## Source and tests

The extension is plain JavaScript, HTML, and CSS with no build step and no required third-party dependencies. Source files and `manifest.json` are at the repository root.

```bash
node tests/reschedule.cjs
```

Build a clean XPI with `python tools/build_xpi.py`. The builder includes **only runtime files**, with `manifest.json` at the archive root; it excludes tests and GitHub documents. The official release attachment is the unmodified publishing XPI.

## Privacy, support and license

Follow-up task metadata and preferences are stored locally in Thunderbird. No analytics, remote processing or automated cloud uploads. Read the [Privacy Policy](PRIVACY.md).

All functionality is free; optional development support: [Ko-fi](https://ko-fi.com/gawkla). Distributed under the [Mozilla Public License 2.0](LICENSE).
