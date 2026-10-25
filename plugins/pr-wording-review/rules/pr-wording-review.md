---
name: pr-wording-review
condition:
  # Punctuation that rarely survives human prose
  - '(?i)\u2014'
  - '(?i)\\u2014'
  # Praise adjectives used as filler
  - '(?i)\bseamless(?:ly)?\b'
  - '(?i)\bcomprehensive(?:ly)?\b'
  - '(?i)\bpivotal\b'
  - '(?i)\bcrucial\b'
  - '(?i)\bvibrant\b'
  - '(?i)\bmeticulous(?:ly)?\b'
  - '(?i)\bgame[- ]changer\b'
  - '(?i)\bgroundbreaking\b'
  - '(?i)\brevolutionary\b'
  # Marketing register
  - '(?i)\bcutting[- ]edge\b'
  - '(?i)\bworld[- ]class\b'
  - '(?i)\bbest[- ]in[- ]class\b'
  - '(?i)\bindustry[- ]leading\b'
  - '(?i)\bstate[- ]of[- ]the[- ]art\b'
  # Stock verbs
  - '(?i)\bdelv(?:e[sd]?|ing)\b'
  - '(?i)\bleverag(?:e[sd]?|ing)\b'
  - '(?i)\butili[sz](?:e[sd]?|ing|ation)\b'
  - '(?i)\bfoster(?:s|ed|ing)?\b'
  - '(?i)\bunderscor(?:e[sd]?|ing)\b'
  - '(?i)\bshowcas(?:e[sd]?|ing)\b'
  - '(?i)\bempower(?:s|ed|ing)?\b'
  - '(?i)\bunlock(?:s|ed|ing)? (?:potential|value|growth)\b'
  # Filler phrases
  - '(?i)\bit(?: is|\x27s) (?:worth noting|important to note)(?: that)?\b'
  - '(?i)\bin order to\b'
  - '(?i)\bdue to the fact that\b'
  - '(?i)\bin conclusion\b'
  - '(?i)\bto summarize\b'
  - '(?i)\bi hope this helps\b'
  - '(?i)\blet me know if you\b'
  - '(?i)\bas an ai(?: language model)?\b'
  # Rhetorical shapes
  - '(?i)\bnot (?:just|only)\b[^.!?\r\n]{0,160}\bbut\b'
  - '(?i)\bin today(?:\x27s|\u2019s) (?:fast[- ]paced world|digital age)\b'
  - '(?i)\bin an era of\b'
  - '(?i)\bserves as\b'
  - '(?i)\bstands as\b'
  - '(?i)\bplays? a (?:crucial|vital|pivotal|significant) role\b'
  # Authority without a citation
  - '(?i)\bexperts believe\b'
  - '(?i)\bindustry reports suggest\b'
  - '(?i)\bstudies show that\b'
scope: "tool:write(*create_pull_request), tool:write(*update_pull_request)"
interruptMode: always
---

Review this pull request text for machine-sounding filler before writing it.
Rewrite only what is genuinely filler, keep technical terms, identifiers, quoted
text and measured claims, then retry. If the flagged word is the precise term,
keep it and say why.
