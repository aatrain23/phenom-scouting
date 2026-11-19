# Phenom Scouting Cards

A searchable scouting card for every Phenom Poker mixed-game regular with 50+ hands in the pool, built from
cash and tournament hand histories. Each read is a stat where a player stands out from everyone else, with the
numbers behind it. Seat the players at your table to see them side by side.

## Adding hands

1. Open the site and drop your Phenom hand-history `.txt` export into **Add your hand histories**.
   The file is read in your browser and never uploaded as-is.
2. Press **Download contribution file**. It holds only per-hand counts of what your opponents did: no hole
   cards, no chip amounts, and not your own screen name.
3. Press **Add it on GitHub**, drag the file in and choose **Propose changes**. Once the change is merged,
   the "Merge contributions" Action rebuilds the data and the site updates for everyone.

No GitHub account? Send the contribution file to the site owner to add.

## How it fits together

- `index.html`, `engine.js`: the site. `engine.js` parses hand histories and builds the cards.
- `seed/`: the starting pool (about 49,000 hands, Mar - Nov 2026).
- `contributions/`: one JSON file per contribution.
- `scripts/merge.js`: rebuilds `data/base.json` and `data/ids.json` from `seed/` plus every contribution,
  skipping hands already counted.
- `.github/workflows/merge.yml`: runs the merge whenever a contribution lands on `main`.
