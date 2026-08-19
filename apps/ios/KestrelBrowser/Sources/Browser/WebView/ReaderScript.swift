import Foundation

public enum ReaderScript {
    public static let extractionScript = """
    (function() {
        try {
            // Find main content container
            var article = document.querySelector('article') || document.querySelector('main') || document.querySelector('.post-content') || document.querySelector('#content');
            var title = document.title || '';
            var h1 = document.querySelector('h1');
            if (h1 && h1.innerText.trim().length > 0) {
                title = h1.innerText.trim();
            }

            var byline = '';
            var authorElem = document.querySelector('[rel="author"]') || document.querySelector('.byline') || document.querySelector('.author');
            if (authorElem) {
                byline = authorElem.innerText.trim();
            }

            var siteName = document.querySelector('meta[property="og:site_name"]')?.content || window.location.hostname;
            var excerpt = document.querySelector('meta[name="description"]')?.content || document.querySelector('meta[property="og:description"]')?.content || '';

            var bodyClone;
            if (article) {
                bodyClone = article.cloneNode(true);
            } else {
                bodyClone = document.body.cloneNode(true);
            }

            // Remove non-content elements
            var removeSelectors = ['script', 'style', 'nav', 'header', 'footer', 'aside', 'iframe', '.ad', '.ads', '.advertisement', '.social-share', '.popup', '#cookie-banner', '.newsletter'];
            removeSelectors.forEach(function(sel) {
                bodyClone.querySelectorAll(sel).forEach(function(el) { el.remove(); });
            });

            var textContent = bodyClone.innerText.trim();
            var contentHtml = bodyClone.innerHTML;

            return {
                title: title,
                byline: byline,
                excerpt: excerpt,
                siteName: siteName,
                textContent: textContent.substring(0, 50000), // bounded
                contentHtml: contentHtml.substring(0, 100000)
            };
        } catch (e) {
            return {
                title: document.title,
                textContent: document.body.innerText.substring(0, 10000),
                contentHtml: document.body.innerHTML.substring(0, 20000)
            };
        }
    })();
    """

    public static let pageSummarizerContextScript = """
    (function() {
        return {
            title: document.title,
            url: window.location.href,
            metaDescription: document.querySelector('meta[name="description"]')?.content || '',
            headings: Array.from(document.querySelectorAll('h1, h2, h3')).map(h => ({ tag: h.tagName, text: h.innerText.trim() })).filter(h => h.text.length > 0).slice(0, 20),
            innerText: document.body.innerText.trim().substring(0, 15000)
        };
    })();
    """
}
