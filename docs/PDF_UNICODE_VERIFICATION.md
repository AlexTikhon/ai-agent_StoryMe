# EN/RU/PL PDF Unicode verification

The renderer-level release test builds deterministic three-page documents in
English, Russian, and Polish. Fixtures include uppercase/lowercase Cyrillic,
`Ё/ё`, Polish `ą ć ę ł ń ó ś ź ż` in both cases, punctuation, and multiline
page text.

For each language the test verifies the exact title/page text before encoding,
absence of the Unicode replacement character, a valid `%PDF-`/`%%EOF` frame,
the exact page-object count, non-trivial output size, and embedded Noto Sans
TrueType font data. This also proves each layout entry produces a non-empty
PDF page.

Reliable post-encoding text extraction is not available in the repository.
PDFKit subsets the embedded font and encodes text streams, so searching raw PDF
bytes is not a valid Unicode extractor. No new PDF framework was added solely
for this release gate. The narrow renderer-level checks are therefore the
authoritative Unicode gate. No generated PDF binary is committed.
