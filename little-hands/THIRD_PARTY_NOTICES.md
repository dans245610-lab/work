# Third-party notices

## MediaPipe Tasks Vision (JavaScript + WebAssembly), version 0.10.14
- Files: `vendor/mediapipe/vision_bundle.js`, `vendor/mediapipe/wasm/*`
- Copyright Google LLC. Licensed under the Apache License, Version 2.0 (`vendor/mediapipe/LICENSE`).
- Source: https://github.com/google-ai-edge/mediapipe · npm: `@mediapipe/tasks-vision`
- Modification: the source-map comment line was removed from `vision_bundle.js` (the file was renamed from `.mjs`).

## MediaPipe models
- `models/hand_landmarker.task` (Hand Landmarker, float16, v1)
- `models/pose_landmarker_lite.task` (Pose Landmarker Lite, float16, v1)
- Copyright Google LLC. Licensed under the Apache License, Version 2.0, as published with the models at
  https://ai.google.dev/edge/mediapipe/solutions/vision/hand_landmarker and
  https://ai.google.dev/edge/mediapipe/solutions/vision/pose_landmarker

## Hand-shape reference data
- `js/handshape-data.js` contains averaged hand-landmark coordinates (no images) computed from the public
  Hugging Face dataset `Marxulia/asl_sign_languages_alphabets_v03`, which was also used to validate the
  hand-shape thresholds. Check that dataset's terms before redistributing this file commercially.

## Linked (not embedded) resources
Example videos and resources are external links to ASL University (Lifeprint), Signing Savvy, the National
Association of the Deaf, NIDCD, the CDC, BabyHearing.org and Hands & Voices. Little Hands is not affiliated
with any of them.
