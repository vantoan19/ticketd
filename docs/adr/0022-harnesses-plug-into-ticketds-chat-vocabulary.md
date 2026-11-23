# Harnesses plug into ticketd's Chat vocabulary

The existing harnesses repeat their identity and capabilities across the core,
host and desktop, and the desktop knows both native tool formats. This decision
gives each harness a descriptor, a runtime and a Step reader. ticketd owns the
vocabulary people see in Chats.

## Decision

- **Descriptor.** A data-only catalog in the core gives both the CLI and the
  Chat host access to harness metadata when the harness is unavailable or
  Chat is off. Each descriptor declares the permissions its
  harness can offer and what it can enforce for an unattended Automation agent,
  such as a command list, read access or a turn cap. A descriptor can also
  declare unattended use unavailable. The host reports which permission choices
  the harness actually makes available.
- **Runtime.** One registration list in the Chat host pairs each core descriptor
  with an adapter factory and a Step reader. The adapter and runtime use the
  existing interfaces. The reader can run independently of the harness.
  Harness names belong to plug-ins and their catalog entries. Callers use stable
  keys and metadata. The desktop gets descriptors and capabilities from the
  host and chooses artwork by mark ID.
- **Step reader.** Each reader maps native tool evidence to ticketd's typed
  actions (Read, Search, Edit, Create, Delete, Run, Web and Other). Actions carry
  their own details and variants, such as List for a Read and Fetch for Web.
  The shared shell classifier refines commands, so `rg x` is a Search. The
  transcript and approval cards use the same reader. The desktop supplies
  wording and display paths.

The Workspace keeps native-shaped tool payloads in its existing records.
Readers classify a Step when the view is built, so improvements apply to saved
Chats without a format migration. History for an unknown harness key is still
readable through a generic reader and a neutral mark.

## Rejected

- **Classify a Step once, when recording it.** A new reader would leave old Chats with
  their old classification. Supporting records from before the change would
  also require a legacy reader.
- **Adopt the Agent Client Protocol (ACP) vocabulary.** That would tie the
  transcript to changes in an external protocol. Mapping native actions into the
  same ticketd vocabulary gives people consistent descriptions across harnesses.
- **Build a generic ACP harness now.** One ACP adapter gives us too little
  evidence of what multiple harnesses would share at the plug-in boundary.
