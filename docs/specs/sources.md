# Sources

Status: planned.

The material content owners bring, and how it becomes something Braivo can teach from ([product.md](../product.md), core job 1). Source content is authoritative for what is taught ("Content first"), so every objective and task derived from it must be traceable back to it. What AI makes from a source belongs to [generation](generation.md); hand-written content stays in [authoring](authoring.md).

## To decide

- Identity and versions: whether an import is an immutable snapshot, and what importing changed material again creates. Re-importing must not silently change what recorded evidence was about.
- Which kinds of source come first (file, URL, pasted text, captions), and what a source keeps: the original, its extracted text, or both.
- What derived content points at: a location in a source (range, page, timestamp), possibly several, and whether hand-written content may point at none.
- Processing: states, partial failure, and retry.
- Deletion: what a source's removal does to derived content and learning history.
