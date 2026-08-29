# Child Profiles API (Phase 14A)

All routes use the `/api` prefix and require authentication. Ownership always comes from the
authenticated principal; no request accepts `userId`. Missing, soft-deleted, and differently
owned profile IDs all return the same `404 Child profile not found` response.

## Public shape

```json
{
  "id": "uuid",
  "name": "Mia",
  "age": 5,
  "createdAt": "2026-08-29T10:00:00.000Z",
  "updatedAt": "2026-08-29T10:00:00.000Z"
}
```

Internal owner, photo/upload, avatar, birthday, pronoun, and deletion fields are not returned in
Phase 14A.

## Routes

### `GET /api/child-profiles?page=1&limit=20`

Returns only active profiles owned by the caller. `page` is clamped to at least 1 and `limit` to
1–20. The response is `{ "items": [], "page": 1, "limit": 20, "total": 0 }`.

### `POST /api/child-profiles`

Accepts `{ "name": "Mia", "age": 5 }`. Name is trimmed and must be 1–80 characters. Age must be
an integer from 1 through 12. A user may have at most 20 active profiles; exceeding the cap
returns `409`.

### `GET /api/child-profiles/:id`

Returns the caller's active profile or the non-enumerating 404.

### `PATCH /api/child-profiles/:id`

Accepts either or both validated fields, for example `{ "name": "Mila", "age": 6 }`. This mutates
only the reusable profile. It never rewrites a Book or GenerationRun.

### `DELETE /api/child-profiles/:id`

Soft-deletes the active owned profile and returns `204`. Existing Books retain
`childProfileId`, `childName`, and `childAge`; existing GenerationRuns remain unchanged.

## Book integration

`POST /api/books` and `PATCH /api/books/:id` accept optional `childProfileId`.

- Omitted/null on create: use the existing manual one-off flow.
- Active owned UUID on create: the server ignores client copies for child name/age and writes the
  selected profile's current values to `Book.childName`/`Book.childAge` with the relation.
- Omitted on update: preserve the current relation and Book snapshot.
- Active owned UUID on update: explicitly reapply the profile's current name/age.
- `null` on update: detach the saved profile while keeping or applying manual Book details.

Generation reads the Book snapshot only. Initial generation/regeneration copies Book values into
`GenerationRun.inputSnapshot`; retry copies the prior run snapshot verbatim. No generation path
queries `ChildProfile`.

Reusable profile photos are not part of Phase 14A. Continue to use the separate per-book
`POST /api/books/:id/child-photo` route.
