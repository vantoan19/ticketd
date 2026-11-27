# Chat attachments belong to their Chat

Take an immutable local snapshot when someone adds a file to a Chat. The Chat owns the snapshot's lifetime and visibility, and a complete Workspace backup carries queued and sent snapshots with their messages. Pasted files stay within the same device-local boundary as the conversation, including in a Workspace that syncs reusable Attachments. The snapshot preserves the file's contents when its source moves or changes.
