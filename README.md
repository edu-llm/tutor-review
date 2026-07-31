# tutor-review

Static review app for AI tutor dialogues from `grpo_tutor` training run v0.
Live at <https://edu-llm.github.io/tutor-review/>.

Reviewers reply as the student with the correct answer hidden, then judge whether
the tutor gave the answer away and whether the hint would help anyone learn.
Answers stay in the browser and are exported as JSON; there is no backend.

Questions and options come from OpenBookQA (openly licensed); the tutor and student
turns are our own models' output. Deployed from `review_app/` in the research repo —
edit there, not here.
