# Assigner sheets — the two-way sync

An assigner never has to open the app to hand work over, and finished work
flows back into their content calendar automatically.

## What they get

**Their CreativeFlow sheet** (we create it, share the link with them):

| Tab | What it's for |
|---|---|
| **Add Tasks** | They type tasks here. Columns A–H are theirs: Title, Team (Graphic/Video), Description, Brief link, Priority, Due date, Due time, Assign To (optional). |
| | Columns I–L are **written by the app** and protected: Task ID, Status, Deliverable link, Sync note. |
| **Completed** | Every task of theirs that reached Done, with its deliverable link and completion time — the feed for their content calendar. |

**Their existing content-calendar sheet** (optional): they share it with the
studio account, we register it, and two tabs appear — **CF Requests** (same
intake as above) and **CF Completed** (same feed). Their own layout is never
touched; they pull from the feed tab with a formula or copy-paste.

## How it behaves

- Every ~10 minutes the sync runs. A row with a Title and no Task ID becomes a
  real task, **created as that assigner** — so their permissions, the 5pm
  same-day cutoff, the team-head notification, and their dashboard all behave
  exactly as if they'd typed it in the app. The Task ID appears in their row.
- Status and Deliverable flow **back** into their row as work progresses.
- Editing Brief / Priority / Due date in their sheet updates the task through
  the normal permission rules (a brief change mid-work still triggers the
  assignee's "Accept updated brief" step).
- **Deleting a row never deletes a task.** Identity is the Task ID, not the row
  number. If a task is archived, their row says so instead of silently
  reappearing.
- A rejected row shows the reason in the Sync note column (e.g. "Same-day tasks
  close at 17:00").

## Why it can't corrupt anything

The engine keeps a hidden shadow of what it last wrote and last saw. That's how
it tells "a human edited this cell" apart from "that's my own earlier write".
The app wins ties. Without the shadow, two-way sync eventually overwrites real
edits — that lesson is why it's there.

## Setup and maintenance

```powershell
# create + share a sheet for one assigner
probe admin <prod-url> <admin> <code> '{"op":"createAssignerSheet","assigner":"Rohit Mehta"}'

# hook up an existing calendar sheet (must be shared to the studio account first)
probe admin <prod-url> <admin> <code> '{"op":"registerCalendarSheet","assigner":"Rohit Mehta","src":"<sheet url>"}'

probe admin <prod-url> <admin> <code> '{"op":"listSyncedSheets"}'
probe admin <prod-url> <admin> <code> '{"op":"setSyncedSheet","sheetId":"<id>","enabled":"No"}'
probe admin <prod-url> <admin> <code> '{"op":"syncNow"}'
```

Registry: the hidden **Synced Sheets** tab in the master sheet.
Every run logs a one-line summary to the Alerts Log
(`created / edits in / out / errors`).
