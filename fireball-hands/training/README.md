# Retraining the ASL letter model

`../asl.js` is generated. To rebuild it:

1. Download `data/train-00000-of-00001.parquet` from the Hugging Face dataset
   `Marxulia/asl_sign_languages_alphabets_v03`, unpack the images to `asl/all/` and write
   `asl/meta.json` (`[[filename, label], ...]`, labels 0-25 = A-Z).
2. `npm i playwright @mediapipe/tasks-vision@0.10.14`, download `hand_landmarker.task` as `hand.task`,
   then `node extract.mjs` → `asl/landmarks.json` (MediaPipe landmarks for every photo).
3. `python3 train.py 128` → `asl/model.npz` (prints validation accuracy and confusions).
4. `python3 export.py` → writes `../asl.js`.

Last run: 8,645 photos with a detected hand, 94.4% accuracy on a held-out 1/7.
