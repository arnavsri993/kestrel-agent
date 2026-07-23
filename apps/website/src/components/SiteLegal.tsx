import Link from "next/link";
import { sitePath } from "../lib/site-path";

type LegalSection = {
  title: string;
  paragraphs?: string[];
  items?: string[];
};

export function SiteLegal({
  eyebrow,
  title,
  summary,
  updated,
  sections
}: {
  eyebrow: string;
  title: string;
  summary: string;
  updated: string;
  sections: LegalSection[];
}) {
  return (
    <>
      <a className="skip-link" href="#policy">Skip to content</a>
      <header className="legal-header">
        <Link className="legal-brand" href="/" aria-label="Kestrel home">
          <img src={sitePath("/brand/workstrand-mark.svg")} alt="" />
          <span><strong>Kestrel</strong><small>local work agent</small></span>
        </Link>
        <Link href="/">Back to product</Link>
      </header>
      <main className="legal-page" id="policy">
        <header className="legal-intro">
          <p className="kicker">{eyebrow}</p>
          <h1>{title}</h1>
          <p>{summary}</p>
          <small>Last updated {updated}</small>
        </header>
        <div className="legal-ledger">
          {sections.map((section, index) => (
            <section key={section.title} aria-labelledby={`legal-${index}`}>
              <span>{String(index + 1).padStart(2, "0")}</span>
              <div>
                <h2 id={`legal-${index}`}>{section.title}</h2>
                {section.paragraphs?.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}
                {section.items && <ul>{section.items.map((item) => <li key={item}>{item}</li>)}</ul>}
              </div>
            </section>
          ))}
        </div>
      </main>
      <footer className="legal-footer">
        <strong>Kestrel</strong>
        <p>Local-first by architecture. Consequential actions stay visible.</p>
        <nav aria-label="Legal and support">
          <Link href="/privacy">Privacy</Link>
          <Link href="/support">Support</Link>
        </nav>
      </footer>
    </>
  );
}
