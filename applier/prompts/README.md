# Editable system prompts

These `.txt` files ARE the system prompts sent to the LLM. Edit them freely to
change behavior — they're re-read on every request, so **no server restart is
needed**; just save and run the action again.

Everything in a file is sent verbatim to the model **except** the `{{PLACEHOLDER}}`
tokens below, which are substituted at request time. Keep the placeholders you
want (you can move them anywhere in the file); a placeholder you delete simply
won't be filled in.

## `tailor.txt` — résumé tailoring (`/tailor`)
| Placeholder | Filled with |
|---|---|
| `{{SUMMARY_MAX}}` | Character budget for the summary = the master summary's length (the one-page guard). Note: the code still hard-trims the summary to this budget after the model responds, regardless of the prompt. |
| `{{WHITELIST}}` | The candidate's genuine-skills whitelist, read from `skills.md` at the repo root (override with the `SKILLS_WHITELIST` env var). Note: the code also enforces this after the model responds — a proposed skill named in neither the whitelist nor the master resume is dropped and logged as `whitelist blocked`. |

The user message (master summary, master skills by category, and the job
description) is assembled in code and is **not** part of this file.

## `answer.txt` — form-question answering (`/answer`)
| Placeholder | Filled with |
|---|---|
| `{{CONTACT}}` | Your contact facts (JSON) from the userscript knowledge base |
| `{{QA}}` | Your known Q&A pairs |
| `{{RESUME}}` | Your résumé text |

The list of form questions is appended as the user message in code.

## Notes
- Override the prompts directory with the `PROMPTS_DIR` env var if you want to
  keep your edits elsewhere.
- If a file is missing, the server errors with the expected path — restore the
  file (or re-create it) and retry.
