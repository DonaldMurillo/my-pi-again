---
name: product-vision
description: >
   Advisory skill for vision alignment. Maintains docs/product-vision.md as a single source
   of truth for what the product is and isn't. Advisory — never blocks a pipeline.
imports:
   - intellectual-honesty
invariants:
   - 'NEVER trigger in /deep-auto — auto mode bypasses all vision prompts silently.'
   - 'NEVER block a pipeline. Vision is advisory, not a gate.'
   - 'Vision doc lives at docs/product-vision.md — one file, one source of truth.'
---

# Product Vision Skill

Advisory skill that provides vision alignment for planning and research phases.

## Bootstrap Trigger

When invoked and `docs/product-vision.md` doesn't exist:

1. Ask the user if they'd like to create one
2. If yes, guide them through:
   - **What we're building** (1-2 paragraphs)
   - **Who it's for** (target users)
   - **Key principles** (3-5 design/technical principles)
   - **What we're NOT building** (explicit scope boundaries)
   - **Current priorities** (ordered list)
3. Write to `docs/product-vision.md`

## Alignment Check

When invoked with a feature description:

1. Read `docs/product-vision.md`
2. Check alignment against principles and priorities
3. Classify: **Aligned**, **Deferred**, or **Scope creep warning**
4. Return classification without blocking

## In Auto Mode

Skip all prompts silently. If vision doc exists, use it for automatic classification.
If it doesn't exist, proceed without vision alignment.
