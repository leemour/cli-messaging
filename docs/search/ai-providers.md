# AI providers for search

Search defaults to local `e5-small` embeddings. Conversation analysis defaults to your own agent using the linking skill; ordinary `conversations build` uses stored messages and local rules. Configuration alone never starts analysis.

These shared SDK settings/options reach MAX and Telegram at their next cli-messaging dependency bump.

All text generation uses the `./models` gateway. Set `models.<purpose>.provider`, `.model`, and
`.baseUrl` for `analysis`, `replies`, or another caller's purpose. Each field falls back to
`models.default`; `provider: off` explicitly disables a purpose. With no provider configured,
the gateway refuses without resolving a key or making a request. A model id is required when
a provider is enabled. Configuration alone never authorizes data transfer.

Existing `analysisProvider`, `analysisModel` and `analysisBaseUrl` remain supported as analysis
settings, ahead of the default-purpose fallback; explicit purpose settings take precedence.
`config set models.analysis.provider openai` sets one field; `config unset models.analysis.provider`
removes it. The whole `models` object can also be set as JSON. `config show` reports effective
values and the source of each field. Environment overrides use names such as
`MAX_MODELS_ANALYSIS_PROVIDER`, `MAX_MODELS_REPLIES_MODEL`, and `MAX_MODELS_DEFAULT_BASE_URL`.

The gateway takes `purpose`, optional `system`, `prompt`, optional untrusted `data`, `maxTokens`
and optional provider-specific `options`. The data is sent separately and never followed as
instructions. Reply blocks may use template metadata at the owner’s insertion points; they must
not copy the incoming message into the reply. Other non-OCR callers keep the no-copy policy.
Options are validated by the selected adapter: unknown keys and wrong types
are refused before any request. OpenAI supports temperature, top_p, presence_penalty,
frequency_penalty, seed, stop, and response_format (text or json_object); Anthropic supports
temperature, top_p, top_k and stop_sequences. Callers cannot override the model, messages,
credentials or token bound through options. The caller supplies a key resolver and a consent
check; consent is checked before keys or network calls. Tests inject fake adapters and fetch.
Gateway callers may supply an AbortSignal, combined with each adapter's request timeout.
Custom hosts literally named `openai` or `anthropic` use key names `endpoint:openai` and
`endpoint:anthropic`; this keeps their credentials separate from public provider keys.
Conversation analysis and AI reply previews register it with the CLI deadline; serve cancels reply
requests on shutdown, so a timed-out one-shot does not leave an HTTP request holding it open.

| Profile setting | Values / default |
|---|---|
| `embeddingProvider` | `local` (default), `openai` |
| `embeddingModel` | Local model ID, or the provider's embedding model; unset uses e5-small locally and text-embedding-3-small at OpenAI |
| `embeddingBaseUrl` | OpenAI-compatible API base, including `/v1` where required |
| `embeddingDims` | Positive vector dimension; required for a custom embedding endpoint |
| `analysisProvider` | `agent` (default), `openai`, `anthropic` |
| `analysisModel` | Explicit model ID from your provider; required for configured analysis |
| `analysisBaseUrl` | OpenAI-compatible API base, or Anthropic API root (without `/v1`) |

`config set` validates values, and `config show` reports their source. Profile and kind-specific configuration use the existing settings layers. Prefixed environment variables such as `MAX_EMBEDDING_PROVIDER`, `MAX_EMBEDDING_MODEL`, `MAX_ANALYSIS_PROVIDER`, `MAX_ANALYSIS_MODEL` and corresponding `_BASE_URL` / `_DIMS` override files. Command options override settings. Changing `--provider` or `--base-url` to a different provider/endpoint starts a new provider choice; give that provider's model/dimensions rather than inheriting another provider's settings. `--provider local --model e5-small` selects local embeddings for one command.

```sh
max config set embeddingProvider openai
max config set embeddingModel text-embedding-3-small
max models text key set openai
max conversations embed --chat '<chat>' --yes

max config set analysisProvider anthropic
max config set analysisModel '<model from your provider>'
max models text key set anthropic
max conversations build --chat '<chat>' --analyze --max-tokens 100000 --yes
```

Keys go in the OS keyring or the existing protected credential file, never config or command arguments. Public OpenAI and Anthropic can use `OPENAI_API_KEY` / `ANTHROPIC_API_KEY`, or their prefixed forms. A custom base URL uses its exact host (including port) as the key name:

```sh
max config set analysisProvider openai
max config set analysisBaseUrl http://localhost:11434/v1
max config set analysisModel '<your installed Ollama model>'
# A remote compatible server that needs a key:
max models text key set '<endpoint host[:port]>'
```

Custom endpoints never inherit the public OpenAI/Anthropic key. URLs must be HTTP/S without embedded credentials, query or fragment. Anthropic is analysis only: [Anthropic offers no embedding model](https://platform.claude.com/docs/en/build-with-claude/embeddings). OpenAI-style analysis uses Chat Completions; custom servers use the compatible `max_tokens` field, while api.openai.com uses `max_completion_tokens`. [Ollama compatibility](https://docs.ollama.com/api/openai-compatibility) covers a subset of that API. Choose a model that returns JSON and token usage; there is no automatic provider fallback or retry.

Before analysis sends its first batch, the CLI explains the endpoint/model, messages, characters, estimated message tokens, and run cap. Machine mode requires `--yes` for a new consent. A yes is remembered for **this account, native chat ID, provider and endpoint path**, across model changes at that endpoint, until revoked. A different chat/account/provider/endpoint requires another yes. This applies to explicitly configured local endpoints too. `conversations embed` still asks for remote message batches on every run; configuring a provider does not waive it. Search with a remote embedding provider sends the query text to that endpoint; MCP search/related/status honor the profile's embedding choice. Bulk refresh stays local.

```sh
max conversations consents list --json
max conversations consents revoke --chat '<chat>'
max conversations consents revoke --provider '<exact identity from the list>'
max conversations consents revoke                     # every remembered analysis consent in this account
```

Revocation removes permission for future batches, including subsequent batches of a running analysis command; an already submitted request cannot be recalled. Local write permissions still apply to analysis, consent storage and revocation. No messenger messages are sent or marked read.

The runner reads the same shipped `link-conversations` skill as your agent, adds a JSON-only response instruction, and calls the existing `batches next` / `links add` logic. Answer messages must be requested by the batch; parents must be earlier messages inside its context. Duplicate IDs, incorrect model/skill, malformed JSON, out-of-range confidence or truncated output fail the entire current batch before links are stored. Previously completed batches remain stored. Successful batches are rebuilt into conversations; remaining work is resumable.

`--size` uses the existing batch bounds (10–200, default 50). `--max-tokens` defaults to 100000 and caps **reservations for both input and output across this run**. Before each request, the runner reserves UTF-8 bytes for the skill/batch plus protocol overhead and at most 4096 output tokens. It stops before a batch that cannot fit, returning `stopped: "budget"`, `remaining`, `tokens` (provider-reported usage) and `reservedTokens`. Reservations are conservative and are not recycled; a command may stop below its actual usage cap. This is a token bound, not a dollar-price quote. Truncated output and usage exceeding a reservation fail the batch. Provider errors contain no remote body, key or message text.

Anthropic uses the official TypeScript SDK and [Messages streaming](https://platform.claude.com/docs/en/cli-sdks-libraries/sdks/typescript); the runner reads the final message and checks its stop reason. The OpenAI-compatible adapter checks the first choice's finish reason and reported token usage. Both adapters are tested with local fake servers; there are no real provider calls in the test suite.

Embedding endpoints must accept requests at the configured URL directly. Set `embeddingBaseUrl` to
the API base serving `/embeddings`; configured gateways use normal HTTP redirect handling.
