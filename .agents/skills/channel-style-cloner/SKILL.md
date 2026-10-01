---
name: channel-style-cloner
description: Analyze, learn, and recreate a YouTube channel's content style through a strict multi-step workflow: branding study, transcript-based Style DNA extraction, original script generation, visual prompt design, thumbnail modeling, and metadata writing. Use this skill whenever the user asks to clone, reverse-engineer, study, imitate, model, or recreate a YouTube channel or creator style, including requests about "Style DNA," style-matched scripts, channel branding, thumbnail patterns, or building a repeatable content engine for a reference channel. Also trigger on Chinese requests such as "复刻频道风格", "拆解频道", "模仿某个博主的内容节奏", or "按这个频道的风格做原创内容", even if the user does not explicitly mention a skill.
---

# Channel Style Cloner

This skill is a rigid state-machine workflow for learning a reference channel's style and turning that analysis into original, style-matched outputs. The order matters because branding, writing, visuals, thumbnails, and metadata depend on each other. Do not compress the workflow, do not skip states, and do not jump ahead just because you think you already know what the user wants.

## Mission

Help the user study another channel deeply enough to reproduce its creative logic while keeping every new deliverable original.

The goal is:
- match style
- match pacing
- match emotional mechanics
- match visual language
- never copy wording, signature lines, or specific creative assets

## Success Definition

The skill is successful when:
- the user can clearly see how the source channel works
- the generated script feels native to that style without sounding copied
- the visual prompts, thumbnails, and metadata feel like the same content ecosystem
- the workflow remains easy to continue from one state to the next

## Operating Rules

- Follow the states in order from 1 to 12.
- Ask for only one new input at a time.
- After each state, stop and wait unless the state explicitly tells you to continue.
- Do not preview future states.
- Do not add filler, summaries of the workflow, or motivational preambles.
- If a state says `Ask:`, output that question or a very close equivalent, then stop.

## Originality Boundary

- Never copy lines, phrases, hooks, taglines, or distinctive wording from the source channel.
- Never reproduce a source transcript with light paraphrasing.
- Extract patterns, not sentences.
- Match how the content works, not the exact words used.
- Any channel-name ideas must be style-adjacent variants, not near-duplicates of the original name.

## Visual Boundary

- Do not ask for non-branding video images before State 7.
- Do not think about shots, framing, B-roll, or camera language while writing the script in State 6.
- Branding screenshots in State 2 are allowed because they support identity analysis rather than shot planning.

## Entry Behavior

When this skill triggers, immediately begin with State 1. Do not greet the user or explain the workflow first.

## Workflow

### State 1: Channel to Clone

Ask: `What channel do you want to clone?`

Then stop.

### State 2: Channel Name and Branding Screenshots

Ask: `Share the channel name and 2-4 screenshots of the channel, such as the profile, banner, About page, or featured section, so I can study the branding.`

Then stop and wait for the screenshots.

Once provided, analyze:
- name style and naming logic
- visual identity
- banner composition and tone
- channel description language
- audience signal and positioning

Output only the branding brief:
- 5 channel name variants
- 2 channel description variants
- 1 logo generation prompt
- 1 banner generation prompt

Then stop.

### State 3: Transcripts

Ask: `Provide 2-3 full video transcripts from this channel.`

Then stop. Do not begin analysis until the transcripts are provided.

### State 4: Topic or Ideas

Ask: `Do you want me to generate video ideas, or do you already have a topic?`

Then stop.

If the user wants ideas:
- propose 5-7 topic ideas in the same niche and voice
- stop and wait for the user to choose one

If the user already has a topic:
- acknowledge it in one line
- continue to State 5 in the same response

### State 5: Style DNA

Analyze the transcripts and extract the Style DNA. Do not summarize what the videos are about. Focus on how they work.

Always cover:
- niche
- target audience
- hook style
- script flow and structural beats
- sentence rhythm
- tone
- transition patterns
- curiosity gaps
- emotional triggers
- retention techniques
- direct-address pattern
- rough words-per-second delivery rate
- average word count across samples
- target word count for the new script within plus or minus 5 percent

Output a tight, scannable profile. Then stop.

### State 6: Original Script Generation

Generate the full script.

Rules:
- lock to the Style DNA from State 5
- match pacing and rhythm
- match emotional flow
- hit the target word count within plus or minus 5 percent
- avoid generic intro/body/outro structures unless the source channel truly uses them
- keep the wording fully original
- do not mention visuals, shots, B-roll, or camera ideas

Before the script, output one line with the target word count.
After the script, output one line with the final word count.

Then stop.

### State 7: Visual Input and Visual Style Profile

Ask: `Upload 3-5 sample video images from the channel, not thumbnails.`

Then stop and wait.

Once provided, extract a Visual Style Profile:
- art style
- color palette
- lighting style
- camera style
- composition
- detail level
- mood

State clearly that all prompts in States 8 and 9 must follow this profile.

Then stop.

### State 8: Image Prompts by Script Beat

Break the entire script into beats of at most 3 seconds of spoken content each. Cover the whole script and do not skip sections.

For each beat, output:
- script segment text
- image prompt
- camera angle
- lighting
- mood
- action

Every image prompt must be fully standalone:
- include subject
- include environment
- include lighting
- include mood
- include camera information
- explicitly name the visual style from State 7
- avoid references to earlier prompts

Then stop.

### State 9: Video Prompts

Ask: `Do you want me to create video prompts for each image prompt?`

If the user says yes:
- generate a video prompt for every image prompt from State 8
- keep each prompt standalone
- preserve the Visual Style Profile from State 7
- add brief camera motion and subject motion

If the user says no:
- continue to State 10

Then stop.

### State 10: Thumbnail References

Ask: `Upload 2-4 thumbnail images from the channel.`

Then stop and wait.

Once provided, analyze:
- text style
- composition
- color contrast
- emotional trigger pattern

Then stop.

### State 11: Thumbnail Concepts

Generate 5 thumbnail options. For each one, provide:
- visual concept
- text overlay
- emotion trigger
- style-matched standalone prompt

Then stop.

### State 12: Title and Description

Generate the final metadata using the script from State 6 and Style DNA from State 5.

Output:
- 3 title variants
- 1 full video description in the source channel's voice and structural logic

End with one short completion line.

## Decision Rules

- If the user provides incomplete branding assets in State 2, continue if the screenshots still reveal clear identity cues; otherwise ask for one missing asset type.
- If the transcripts are partial, say that Style DNA confidence is lower and continue only if there is enough material to infer pacing and structure.
- If the user asks for direct copying, refuse the copying part and continue with a style-matched original approach.
- If the source channel spans multiple formats, infer the dominant format from the transcripts before generating the script.
- If the user wants only one specific stage, still keep the state order up to that stage rather than free-styling the workflow.

## Forbidden Moves

- Do not summarize future steps before doing the current one.
- Do not generate a script before transcript analysis.
- Do not generate image prompts before the script exists.
- Do not generate thumbnail concepts before thumbnail references are analyzed.
- Do not drift into generic creator advice unless the current state explicitly calls for it.
- Do not confuse "same style" with "same words."

## Review Standard

Before finalizing any analysis or generation inside a state, quickly self-check:
- Is this style-matched rather than copied?
- Is this based on the right evidence for this state?
- Did I output only what this state requires?
- Did I stop at the right point?

If any answer is no, revise before responding.
