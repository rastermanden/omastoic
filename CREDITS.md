# Credits

## Portraits

The braille portraits in `art/` are AI-generated likenesses, made with Grok
Imagine and committed in `assets/local/`. No portrait here is a photograph of a
surviving bust, and none should be taken as evidence of what these men looked
like — of the six, only Marcus Aurelius has a securely identified ancient
likeness at all, and the rest were guesswork long before a model was asked.
They are illustrations for a screensaver, labelled as such.

`scripts/transcode.ts` rebuilds `art/` from them; `assets/portraits.json`
records the crop and threshold each one is reduced with. What the repository
commits is a halved, greyscaled copy of each source; the full-resolution
originals are a release asset, fetched with
`./scripts/fetch-sources.sh --originals`.

The table describes provenance, not a separate image-license grant. This
correctness release does not replace or re-clear the existing illustrations;
historically sourced, cleared portraits are a follow-up. The MIT code license
and the translation status below should not be read as image-rights evidence.

| Portrait | Source | Provenance |
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

Every entry was reviewed against the following **public-domain US source
editions**: the 64 shipped in 2.2.0, then 15 and five further entries added
from the same editions. Antiquity alone does not clear a modern translation, and
public-domain status is jurisdiction-dependent (not a worldwide license claim).
The underlying translations/versions below were published before 1931; the
undated McKay scan corroborates Long, rather than supplying a new rights basis.
Basore's later dialogues and
unidentified internet translations are no longer used.

| Author / source | Translator and edition | Public source |
| --- | --- | --- |
| Marcus Aurelius, *Meditations* | George Long, 1862; book/section numbering | [Internet Classics Archive, MIT](https://classics.mit.edu/Antoninus/meditations.html) |
| Epictetus, *Discourses*, *Enchiridion* | George Long, 1877 translation; *A Selection from the Discourses … with the Encheiridion*, Gutenberg transcription; corroborating full text in the McKay reprint below | [Text and edition](https://www.gutenberg.org/ebooks/10661) |
| Epictetus, attributed *Fragments* | George Long, 1877 translation; undated David McKay, Philadelphia reprint of *The Discourses … with the Encheiridion and Fragments*, p. 419, fragment XXV | [Scan](https://archive.org/details/discoursesepicte00epiciala/page/419/mode/1up) |
| Seneca, *Moral Letters to Lucilius* | Richard M. Gummere, Loeb Classical Library, London: Heinemann / New York: Putnam; vol. I (letters 1–65), 1917; vol. II (66–92), 1920; vol. III (93–124), 1925 | [Scan-backed text by letter](https://en.wikisource.org/wiki/Moral_letters_to_Lucilius); [vol. I](https://www.stoics.com/seneca_epistles_book_1.html), [II](https://www.stoics.com/seneca_epistles_book_2.html), [III](https://www.stoics.com/seneca_epistles_book_3.html) |
| Seneca, *On Anger*, *On Providence*, *On the Shortness of Life* | Aubrey Stewart, *Minor Dialogues, Together with the Dialogue on Clemency*, London: George Bell & Sons, 1889 | [Text and edition](https://www.gutenberg.org/ebooks/64576) |
| Zeno, Cleanthes, Chrysippus, reported in Diogenes Laertius VII | C. D. Yonge, *Lives and Opinions of Eminent Philosophers*, 1853 translation, 1895 edition; canonical Greek section numbers (not Yonge's internal paragraph numbers) | [VII.1–37](https://www.attalus.org/old/diogenes7.html), [38–93](https://www.attalus.org/old/diogenes7b.html), [160–189](https://www.attalus.org/old/diogenes7d.html) |
| Cleanthes, prayer to Zeus and Destiny | Quoted by Epictetus, *Enchiridion* 53, Long translation above (numbered LII in the selection); **not** the *Hymn to Zeus* | [Long text](https://www.gutenberg.org/ebooks/10661) |
| Chrysippus, quoted critically by Plutarch | *The Contradictions of the Stoics* 34 (Moralia 1050A), E. Smith, revised William W. Goodwin; *Essays and Miscellanies*, vol. IV, Boston: Little, Brown, 1911 printing (copyright editions 1870/1898/1905) | [Text, title page and translator list](https://www.gutenberg.org/ebooks/79588) |

### Editorial record

[The source ledger](docs/quote-sources.json) keeps a stable ID for every entry,
the reviewed citation, edition, public URL, independent source passage and
attribution note. Tests compare the runtime book with these passages offline;
they cannot establish ancient authorship. Capitalization, whitespace, quotation
marks and terminal punctuation are normalized. Internal omissions are marked
with **…**, rather than silently joining separated sentences.

The full 64-entry set is retained, with wording repaired to the credited
translations. Corrections extend beyond the two initially reported errors:

- “ten thousand years”: *Meditations* **IV.17**, not II.11.
- Anger/delay: **On Anger II.29**, Stewart, not Letters 78.13.
- “postpone nothing”: **Letters 101.7**, not 61.4; “every day”: **12.8**, not
  101.7; unexpected troubles: **13.10**, not 24.1; trust: **3.4**, not 3.6;
  virtue learned: **123.16**, not 8.5.
- Hurrying through life: **Shortness 7.8**, not 2.5. Fragment poverty/desire:
  **XXV in Long**, not an unqualified “Fragments 8”. Chrysippus/multitude:
  **Diogenes VII.182**, not 183.
- The untraceable “Cling to philosophy, that harbour …” wording at Letters
  123.16 is repaired with Gummere's actual refuge-in-philosophy passage,
  **14.11**. Cleanthes' old-age answer is Yonge's actual **VII.174**, not the
  untraceable wording attributed to VII.171.
- Seneca's final willing/unwilling line in **107.11** expands his adaptation
  of Cleanthes. It is now labelled **Seneca (after Cleanthes)**, not directly
  attributed to Cleanthes. The separate Greek prayer remains with Cleanthes.
- Seneca's poverty maxim in **2.6** is his comment after a quotation from
  Epicurus, not itself the preceding Epicurus quotation. Diogenes reports
  that the Zeno/goodness saying was also attributed to Socrates. Long's collected fragments are attributed material, not all
  securely authentic. These transmission limits are recorded, not concealed.
- Fifteen further entries were added later from the same editions: Marcus
  *Meditations* VII.71, VII.34, VII.15, VII.8, V.2, IV.37, VI.54; Seneca
  *Letters* 5.5, 5.9, 24.19, 28.1; Epictetus *Enchiridion* 6, 14, 23, 42. They
  are appended after the original rows, so the existing `q01`–`q64` ids keep
  pointing at the same lines.
- Five further entries are appended as `q80`–`q84`: Marcus *Meditations* III.4
  and IV.49; Seneca *Letters* 7.8 and 20.1; Epictetus *Discourses* I.15.
  Existing quote IDs remain unchanged.
