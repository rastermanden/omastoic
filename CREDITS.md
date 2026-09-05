# Credits

## Portraits

The braille portraits in `art/` are AI-generated likenesses, made with Grok
Imagine and committed in `assets/local/`. No portrait here is a photograph of a
surviving bust, and none should be taken as evidence of what these men looked
like — of the six, only Marcus Aurelius has a securely identified ancient
likeness at all, and the rest were guesswork long before a model was asked.
They are illustrations for a screensaver, labelled as such.

`scripts/transcode.ts` rebuilds `art/` from them; `assets/portraits.json`
records the crop and threshold each one is reduced with.

| Portrait | Source | License |
| --- | --- | --- |
| Marcus Aurelius | Imagined bust of Marcus Aurelius — generated with Grok Imagine | AI-generated |
| Seneca | Imagined portrait of Seneca — generated with Grok Imagine | AI-generated |
| Epictetus | Imagined portrait of Epictetus — generated with Grok Imagine | AI-generated |
| Zeno of Citium | Imagined portrait of Zeno of Citium — generated with Grok Imagine | AI-generated |
| Cleanthes | Imagined portrait of Cleanthes — generated with Grok Imagine | AI-generated |
| Chrysippus | Imagined portrait of Chrysippus — generated with Grok Imagine | AI-generated |

Through 1.x the portraits were transcoded from public-domain and CC0 museum
photographs instead — the Glyptothek's Marcus Aurelius, the Met's Rubens drawing
after the Pseudo-Seneca, Bonnart's engraving of Epictetus, and the Ny Carlsberg
Glyptotek's Zeno and Cleanthes. Those entries are in the git history, and
`scripts/fetch-sources.sh` still fetches any portrait whose `origin` is
`commons`.

## Translations

Every quote in `data/quotes.tsv` comes from a translation that is out of
copyright, and is cited by book and section so it can be checked against the
text:

- **Marcus Aurelius**, *Meditations* — George Long (1862)
- **Epictetus**, *Enchiridion* and *Discourses* — George Long (1877), with
  Elizabeth Carter (1758)
- **Seneca**, *Moral Letters to Lucilius* — Richard M. Gummere (1917–25);
  *On the Shortness of Life* and *On Providence* — John W. Basore (1928–35)
- **Zeno, Cleanthes, Chrysippus** — Diogenes Laertius, *Lives of the Eminent
  Philosophers*, trans. C. D. Yonge (1853)

Lines that circulate widely under a Stoic's name but have no source behind them
are deliberately absent, however well they scan.
