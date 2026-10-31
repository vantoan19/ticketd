# Plate editing with canonical Markdown

Use Plate for rich document editing in ticket descriptions and notes, with shadcn-based controls and locally rendered Mermaid diagrams. Its customizable block experience matches the chosen product direction; we accept responsibility for plugin integration and upgrades rather than selecting an editor primarily for its ready-made Markdown workflow.

Markdown remains canonical in storage, CLI responses, and exports. Plate document trees are transient UI state. Limit rich authoring to supported CommonMark/GFM constructs and fenced Mermaid source; do not introduce MDX or editor-specific JSON as a persistence requirement. Keep CodeMirror for source editing and recovery when content cannot safely be edited visually.

Viewing or focusing a document must not rewrite its source. Rich edits must preserve supported content semantically and retain Mermaid source exactly. Unsupported content must be preserved or routed to source editing before a rich save can discard it. Adoption requires validation of these boundaries and native desktop interactions; selecting Plate does not establish that its default conversion is lossless.

Drafts and external updates continue to follow [ADR-0003](0003-defer-record-versioning.md). Description autosave and explicit note submission remain separate application behaviors. Mermaid rendering runs locally with bounded input and protected security settings; diagram errors retain editable source.
