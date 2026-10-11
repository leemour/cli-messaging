import assert from "node:assert/strict"
import { test } from "vitest"
import { planQuestion } from "./question-plan.js"

test("question scaffolding changes while content and filters survive", () => {
  const plan = planQuestion("How many days are logs kept for Canyon log retention? chat:301 from:700")
  assert.ok(plan.changed)
  assert.equal(plan.scope, "chat:301 from:700")
  assert.ok(plan.queries.every((q) => q.includes("days") && q.includes("canyon") && q.endsWith("chat:301 from:700")))
  assert.ok(plan.queries.some((q) => !q.includes("kept")))
})
test("unknown content is never removed or guessed from a vocabulary", () => {
  const plan = planQuestion("How many ultraviolet logs are kept for Canyon log retention? chat:301")
  assert.ok(plan.queries.every((q) => q.includes("ultraviolet")))
  const auditor = planQuestion("Who is the external auditor for Canyon refund amount? chat:301")
  assert.ok(auditor.queries.every((q) => q.includes("external auditor")))
})
test("Russian question handling preserves numeric and scope requirements", () => {
  const plan = planQuestion("Сколько дней хранятся логи по Опал хранение логов? chat:305 date:2026-10-08")
  assert.ok(plan.changed)
  assert.ok(
    plan.queries.every((q) => q.includes("днеи") && q.includes("опал") && q.endsWith("chat:305 date:2026-10-08")),
  )
})
test("explicit operators, phrases, wildcards and SDK strict flags stay unchanged", () => {
  for (const q of [
    "Canyon AND retention",
    '"Canyon log retention"',
    "Canyon reten*",
    "Canyon OR retention",
    "What is Canyon AND retention?",
  ])
    assert.deepEqual(planQuestion(q).queries, [q])
  assert.deepEqual(planQuestion("How many logs?", true).queries, ["How many logs?"])
  assert.deepEqual(planQuestion("", true).queries, [""])
})
test("an empty question cannot turn into a scope-only search", () => {
  const raw = "What is? chat:301"
  assert.deepEqual(planQuestion(raw).queries, [raw])
})

test("Russian indirect questions retain permissions and unknown role qualifiers", () => {
  const plan = planQuestion("Кому сейчас разрешён Опал доступ на сервер? chat:305")
  assert.ok(plan.changed)
  assert.ok(plan.queries.every((q) => !q.includes("кому") && q.includes("разрешен")))
  const unknown = planQuestion("Кому из внешних аудиторов разрешён доступ? chat:305")
  assert.ok(unknown.queries.every((q) => q.includes("внешних") && q.includes("аудиторов")))
})

test("temporal content is not discarded as generic question scaffolding", () => {
  const plan = planQuestion("What happened after Canyon rollout? chat:301")
  assert.ok(plan.queries.every((q) => q.includes("after")))
})

test("ordinary questions do not require a question mark", () => {
  assert.deepEqual(
    planQuestion("Who currently has Canyon production access chat:301").queries,
    planQuestion("Who currently has Canyon production access? chat:301").queries,
  )
  assert.ok(planQuestion("К кому теперь обращаться по Опал контакт инцидента").changed)
})

test("bounded retention aliases preserve unrelated qualifiers", () => {
  const plan = planQuestion("Какой срок хранения логов по Опал ultraviolet?")
  assert.ok(plan.queries.some((q) => q.includes("хранение") && !q.includes("срок")))
  assert.ok(plan.queries.every((q) => q.includes("ultraviolet")))
})

test("question punctuation is removed only from the text leaf, preserving filter punctuation", () => {
  const plan = planQuestion('When does Helix export run? chat:"Which chat?" date:2026-10-08')
  assert.ok(plan.changed)
  assert.ok(plan.queries.every((q) => q.includes('chat:"Which chat?"')))
  assert.ok(plan.queries.every((q) => q.includes("date:2026-10-08")))
  assert.ok(plan.queries.every((q) => !q.includes("run?")))
})
test("a long repeated field suffix is parsed without an ambiguous nested repetition", () => {
  const suffix = "chat:chat:".repeat(100)
  assert.throws(() => planQuestion(`What is Helix export? chat:${suffix}end`))
  const plan = planQuestion(`What is Helix export? chat:"${suffix}end"`)
  assert.ok(plan.changed)
  assert.ok(plan.queries.every((q) => q.endsWith(`chat:"${suffix}end"`)))
})

test("question words in a filter title cannot turn keywords into a question", () => {
  const text = 'Helix chat:"What?"'
  assert.deepEqual(planQuestion(text).queries, [text])
  assert.equal(planQuestion(text).changed, false)
})

test("permission questions preserve subjects, negation and scope", () => {
  for (const text of [
    "Can contractors access Nimbus now? chat:101",
    "Could contractors access Nimbus chat:101",
    "Should vendors connect to Nimbus? chat:101",
    "Подрядчики могут подключиться к Лотос сейчас? chat:101",
    "Можно подключиться к Лотос? chat:101",
    "Разрешено ли подключение к Лотос? chat:101",
  ]) {
    const plan = planQuestion(text)
    assert.ok(plan.changed, text)
    assert.equal(plan.scope, "chat:101")
    assert.ok(plan.queries.every((q) => !q.includes("?")))
  }
  assert.ok(planQuestion("Can contractors not access Nimbus?").terms.includes("not"))
  assert.ok(planQuestion("Подрядчики не могут подключиться к Лотос?").terms.includes("не"))
  for (const text of ["Can access Nimbus AND vendors?", "Can access Nim*?", "Nimbus report?", "Nimbus canary?"])
    assert.deepEqual(planQuestion(text).queries, [text])
})
