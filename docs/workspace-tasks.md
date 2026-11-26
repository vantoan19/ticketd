# Back up, share, or sync your work

## Back up and restore your workspace

The desktop saves a **restore point** the first time you open ticketd each day and keeps the
last 7, so you can go back a few days without having done anything.

1. Open **Settings → Backups & export**. **Restore points** lists them, newest first. To
   add one before something risky, choose **Back up now**: it is saved at once, checked,
   and needs no file.
2. To recover, choose **Restore…** on a point. Copies saved before a restore or an update
   are listed too, with a label. **Restore from a file…** reviews a copy made with
   `ticketd backup` or on another computer. Review the copy and the workspace it would
   replace. You can cancel here.
3. Choose **Replace workspace** to restore the reviewed copy. ticketd first
   saves a safety copy of the current workspace, which then appears in the list.
   After **Workspace restored**, open a familiar ticket to check its content.

Restore points stay on this computer: they are not synced and a copy of the Workspace file
alone does not carry them. For a copy to keep elsewhere, run `ticketd backup PATH`.
Drive credentials and remote files stay outside the backup. Restoring disconnects
Workspace sync. Reconnect deliberately when you're ready to sync the restored
data. [Backup and restore commands](../crates/ticketd-cli/skill-data/workspace.md#backup-export-and-restore)

## Share a ticket as Markdown

1. Open the ticket, choose **Ticket actions** (the three dots), then
   **Export Markdown with files…**. Choose a destination folder.
2. In the result, choose **Show manifest** to see which files were copied,
   linked, or omitted. For **Export partially complete**, review the omissions
   before sharing. A recipient needs their own access to open a Drive link.
3. Send the whole new `ticketd-export-*` folder. The recipient can open
   `content.md` with its relative file links intact.

This export contains the ticket's title, description, and direct attachments.
Choose a workspace backup when you want to restore tickets and their history.
[Export contents and file format](export.md#portable-markdown-with-files)

## Sync two desktops with Google Drive

1. On the computer with the workspace you want to keep, open **Settings →
   Workspace sync**, choose **Start with this Workspace**, then **Continue**.
   Choose **Google Drive** and **Connect Google Drive**. Sign in to the account
   you will use on both computers. Sync writes readable, unencrypted files to
   that Drive, so check who can access the folder.
2. When ticketd finds no Workspace in that Drive, it starts the first upload
   by itself. Wait for the upload to finish.
3. On the second computer, choose **Join from another computer** and connect
   the same account. ticketd reads the Drive first and preselects **Join** for
   the folder the first computer created, even if this computer already holds
   tickets. Choose **Join…** and review the replacement before confirming.
   Joining replaces this computer's workspace after a safety backup. If it
   holds independent work you need, back it up first.
4. Open a ticket on the second computer and compare its reference with the
   first. Changes sync while the desktop app is open. If both computers edit
   the same field, open **Needs review** to choose the content to keep.

To sync through an S3 bucket instead, see [S3 sync setup](install.md#s3-sync-setup).

[What syncs and what stays local](../PRIVACY.md#workspace-sync) · [How Workspace sync handles changes](product.md#workspace-sync)
