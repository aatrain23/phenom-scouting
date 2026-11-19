# Contributions

Each `.json` file here was made by the site's **Add hands** box. It holds opponent action counts per hand
(entered the pot, raised, folded to a bet, stood pat, showed down), the game, the date and a hand ID.
It holds no hole cards, no chip amounts and not the name of the person who uploaded it.

When a file lands here, the "Merge contributions" GitHub Action rebuilds `data/base.json` and the site updates
a minute or two later. Hands already in the pool are skipped.
