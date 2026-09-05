---
name: h3-prompt-writing
description: Write MiniMax H3 video generation prompts for T2VA, I2VA, FL2VA, L2VA, and Ref2VA. Use when rewriting multimodal requests into H3 prompt structures, composing integrated_multimodal_description, overall_soundscape, and non_diegetic_music, aligning keyframes, or defining reference labels for images, videos, and audio.
compatibility: Portable to any agent that can read local files — no external API calls, MiniMax Hub tools, or proprietary runtime required. The agents/openai.yaml file only adds optional ChatGPT/Codex UI metadata; it does not restrict the skill to OpenAI agents.
---

# H3 Prompt Writing

## Workflow

1. Identify the input mode: T2VA, I2VA, FL2VA, L2VA, or full-reference Ref2VA.
2. For base text/keyframe modes, read `references/base-en.txt` and follow its final prompt structure.
3. For full-reference mode, read `references/ref-en.txt` and follow its six-section rewrite format.
4. Preserve the exact field names, section order, labels, and timing notation from the selected guide.

## Base Modes

- T2VA: build the full audiovisual timeline from text.
- I2VA: start from the first frame and develop forward from it.
- FL2VA: describe the continuous path between the first and last frames.
- L2VA: infer a plausible opening and converge to the supplied last frame.

Use `integrated_multimodal_description`, `overall_soundscape`, and `non_diegetic_music` in the order shown in `references/base-en.txt`.

## Full-Reference Mode

Ref2VA rewrites use `subject_definitions`, `summary`, `retention_analysis`, `detailed_description`, `overall_soundscape`, and `non_diegetic_music` in that order. Reference labels stay consistent across all sections.

Read `references/ref-en.txt` for label rules, retention analysis, and complete examples.

## Output Rules

- Write rewrite sections in English; preserve dialogue, lyrics, and visible scene text in their original language.
- Describe each shot by composition, subjects, environment, actions, camera, sound, and the exact point where referenced content appears.
- Avoid plot summaries, unresolved reference labels, and timing that does not match the requested duration.

## Character Identity Lock

When a role card or character three-view is referenced, carry its confirmed identity facts into the Ref2VA text; the image input alone is not enough for reliable wardrobe continuity.

- Define one `<Subject N>` per referenced character and bind it to the matching `<Picture N>`.
- In `subject_definitions`, state the stable face, hair, skin tone, body proportions, wardrobe silhouette, concrete color blocks, materials, and distinctive props. Do not use only "same clothes" or "keep consistent".
- Mark the character `fully_preserved` in `retention_analysis` and enumerate the identity and wardrobe attributes that cannot change.
- Repeat the same `<Subject N>`/`<Picture N>` binding in every applicable `detailed_description` shot. Add explicit prohibitions for known drift, such as alternate wardrobe colors, a surgical cap, or a different scrub color.
- Keep stable identity separate from shot state. Only confirmed or explicitly requested temporary costumes and medical accessories may change; report conflicting role-card and three-view facts instead of blending them.

For color-critical wardrobe, use concrete color names and approximate values when supported by the reference, and keep lighting/grading neutral enough that those color blocks remain recognizable. Normal illumination changes are allowed; recoloring is not.
