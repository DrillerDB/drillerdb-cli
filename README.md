# drillerdb

Read-only access to DrillerDB's partner API and free public lookups. Every network request is a GET. JSON output is one document on stdout; errors go to stderr. The CLI has no runtime dependencies.

## Install

After the initial release is published on npm:

```sh
npm install -g drillerdb
drillerdb --help
```

Requires Node 18.7 or newer (`node:util.parseArgs` token output, used to reject duplicate options, was introduced in 18.7). For a local build before publication, use `npm ci`, `npm run build`, then `node dist/cli.js --help`. Development tests use `npm test` (Hive lanes must run the test runner through their assigned node suite slot).

## Public commands

No key is required. These commands use `https://drillerdb.com` by default. A partner key in the environment or command line is never sent to a public endpoint.

```sh
drillerdb wells depth --lat 44.5236 --lng -89.5746
drillerdb drillers license --state WI --name 'Well Drilling'
drillerdb drillers license --state WI --license 1234
drillerdb drillers nearby --zip 54401 --radius 25 --limit 5
drillerdb drillers nearby --lat 44.9591 --lng -89.6301 --limit 5
drillerdb geo zip 54401
drillerdb stats
```

Depth lookups accept US coordinates only: latitude 18 to 72 and longitude -178 to -66. License lookups accept a state abbreviation or slug and exactly one name or license number, each at least two characters. Nearby lookups require a five-digit ZIP or both coordinates, with radius 0.01 to 150 miles and limit 1 to 250. Negative coordinate values can also use `--lng=-89.5746`.

## Partner authentication and hosts

An Enterprise partner API key with the relevant read scopes is required. Set `DRILLERDB_API_KEY` in your shell environment using your own secret-management workflow. `--api-key <key>` overrides the environment value, but shell history and process listings may expose command-line secrets, so prefer the environment. Keys go only in the `X-API-Key` request header. The CLI redacts the supplied key from JSON, tables and errors; a normal key's first four characters remain as a prefix followed by `[REDACTED]`.

The default partner base is `https://console.drillerdb.com/api/partner/v1`. The classic API accepts the same resources and keys at `https://app.drillerdb.com/api/v1`:

```sh
drillerdb projects list --base-url https://app.drillerdb.com/api/v1
```

`--base-url` overrides `DRILLERDB_BASE_URL`, which overrides the command's default host. A custom base applies to the selected command; use an origin without `/api/partner/v1` for public lookups. HTTPS is required; HTTP is accepted only on loopback for local tests. Base URLs cannot contain credentials, queries or fragments. Redirects are refused to prevent forwarding a key to another endpoint. Partner commands send the key only to `console.drillerdb.com` and `app.drillerdb.com` (or loopback for tests). Any other host is refused unless you also pass `--allow-custom-host`, which prints a warning to stderr, so a wrong or planted `DRILLERDB_BASE_URL` cannot receive the key. Keys shorter than 8 characters are refused.

## Partner commands

IDs in these examples are placeholders from your own company. Equipment IDs are strings; the other resource IDs are positive integers.

```sh
drillerdb projects list --limit 50 --updated-since 2026-10-01T00:00:00Z
drillerdb projects get 123
drillerdb projects invoices 123 --limit 50
drillerdb work-orders list --limit 50
drillerdb work-orders get 123
drillerdb contacts list --updated-since 2026-10-01T00:00:00Z
drillerdb contacts get 123
drillerdb equipment list --limit 50
drillerdb equipment get rig-7
drillerdb inventory list --limit 50
drillerdb inventory get 123
```

List commands, including project invoices, accept `--limit` (1 to 200), `--cursor` and `--all`. `--updated-since` accepts an ISO timestamp with a timezone and is supported only on projects, contacts, equipment and inventory lists. Unsupported options are usage errors.

```sh
drillerdb projects list --cursor opaque-cursor --limit 100
drillerdb contacts list --all --limit 100
```

Without `--all`, output preserves the API envelope. With `--all`, the CLI follows `meta.next_cursor` and emits one envelope whose `data` combines all pages. `meta.pages` and `meta.count` describe the aggregate, `meta.next_cursor` is null, and `meta.has_more` is false. The first page's `links.self` and last page's other metadata remain; `links.next` is null. Cursor repetition, malformed pages and more than 1,000 pages fail with no partial stdout. For larger exports, request pages yourself using `--cursor`.

## Output and OpenAPI

```sh
drillerdb projects list --format table
drillerdb openapi
drillerdb openapi --document
drillerdb openapi --partner
drillerdb openapi --partner --document
```

`--format json` is the default. Table output uses the fields of each returned record and renders nested values as JSON. `openapi` prints the spec URL as a JSON string; `--document` downloads the JSON document without a key.

- [Partner integration documentation](https://drillerdb.com/docs/integrations/partner-api)
- [Public OpenAPI](https://drillerdb.com/openapi.json)
- [Console partner OpenAPI](https://console.drillerdb.com/api/partner/v1/openapi.json)
- [Classic partner OpenAPI](https://app.drillerdb.com/api/v1/openapi.json)

## Rate limits and failures

The public site has a shared 500-request-per-IP minute limit. Partner limits are per key, per minute and per day. On HTTP 429, the CLI honors `Retry-After` (seconds or HTTP date) with at most two retries and a maximum 30-second wait for each retry. A longer delay exits 4 immediately so you can schedule a later attempt. `--no-retry` disables 429 retries. Other error statuses are never retried.

During `--all`, a `RateLimit` policy with remaining `r` at or below 5 slows the next page according to its reset time `t`, using the longest delay across policies. Waits over 30 seconds exit 4 without partial output. If the server does not send these fields, pagination continues without this pacing; 429 handling still applies. Requests time out after 20 seconds.

API failures include `error.code`, `error.message`, an available hint and `meta.request_id` on stderr. Non-JSON responses and refused redirects are API/protocol errors. Network error text does not include the requested URL or headers.

| Exit | Meaning |
| --- | --- |
| 0 | Success or help |
| 1 | API or response protocol error |
| 2 | Invalid command, argument or missing partner key |
| 3 | Network failure or timeout |
| 4 | Rate limit; retries exhausted, disabled or wait budget exceeded |
| 5 | Internal CLI error (the message never includes request details) |

## License

MIT. See LICENSE.
