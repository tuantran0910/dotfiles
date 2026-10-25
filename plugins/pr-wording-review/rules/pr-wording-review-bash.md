---
name: pr-wording-review-bash
# Every condition requires a `gh pr create|edit` verb AND a matched pattern in
# the same command. Pairing them prevents interrupts on unrelated commands that
# happen to contain a flagged word.
condition:
  - '(?i)(?=[\s\S]*\bgh\s+pr\s+(?:create|edit)\b)(?=[\s\S]*(?:\u2014|\\u2014))'
  - '(?i)(?=[\s\S]*\bgh\s+pr\s+(?:create|edit)\b)(?=[\s\S]*\b(?:seamless(?:ly)?|comprehensive(?:ly)?|pivotal|crucial|vibrant|meticulous(?:ly)?|game[- ]changer|groundbreaking|revolutionary)\b)'
  - '(?i)(?=[\s\S]*\bgh\s+pr\s+(?:create|edit)\b)(?=[\s\S]*\b(?:cutting[- ]edge|world[- ]class|best[- ]in[- ]class|industry[- ]leading|state[- ]of[- ]the[- ]art)\b)'
  - '(?i)(?=[\s\S]*\bgh\s+pr\s+(?:create|edit)\b)(?=[\s\S]*\b(?:delv(?:e[sd]?|ing)|leverag(?:e[sd]?|ing)|utili[sz](?:e[sd]?|ing|ation)|foster(?:s|ed|ing)?|underscor(?:e[sd]?|ing)|showcas(?:e[sd]?|ing)|empower(?:s|ed|ing)?)\b)'
  - '(?i)(?=[\s\S]*\bgh\s+pr\s+(?:create|edit)\b)(?=[\s\S]*\bunlock(?:s|ed|ing)?\s+(?:potential|value|growth)\b)'
  - '(?i)(?=[\s\S]*\bgh\s+pr\s+(?:create|edit)\b)(?=[\s\S]*\b(?:it(?: is|\x27s)\s+(?:worth noting|important to note)|in order to|due to the fact that|in conclusion|to summarize|i hope this helps|let me know if you|as an ai(?: language model)?)\b)'
  - '(?i)(?=[\s\S]*\bgh\s+pr\s+(?:create|edit)\b)(?=[\s\S]*\b(?:in today(?:\x27s|\u2019s)\s+(?:fast[- ]paced world|digital age)|in an era of|serves as|stands as|plays? a (?:crucial|vital|pivotal|significant) role)\b)'
  - '(?i)(?=[\s\S]*\bgh\s+pr\s+(?:create|edit)\b)(?=[\s\S]*\b(?:experts believe|industry reports suggest|studies show that)\b)'
  - '(?i)(?=[\s\S]*\bgh\s+pr\s+(?:create|edit)\b)(?=[\s\S]*\bnot (?:just|only)\b[^.!?\r\n]{0,160}\bbut\b)'
scope: "bash"
interruptMode: always
---

Review this pull request text for machine-sounding filler before writing it.
Rewrite only what is genuinely filler, keep technical terms, identifiers, quoted
text and measured claims, then retry. If the flagged word is the precise term,
keep it and say why. Note: `--body-file` contents are not inspected by this rule.
