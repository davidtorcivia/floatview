const urlInput = document.getElementById('url-input');
const goBtn = document.getElementById('go-btn');

async function navigate() {
    const raw = urlInput.value.trim();
    if (!raw) return;

    let url = raw;
    if (!url.match(/^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//)) {
        if (url.includes(' ') || (!url.includes('.') && !url.includes(':'))) {
            url = 'https://duckduckgo.com/?q=' + encodeURIComponent(url);
        } else {
            url = 'https://' + url;
        }
    }

    let parsed;
    try {
        parsed = new URL(url);
    } catch {
        parsed = null;
    }
    // Anything that doesn't resolve to an http(s) URL (unparseable, or
    // an explicit ftp:/file:/etc. scheme) becomes a web search rather
    // than silently doing nothing — so the Launch button always
    // responds to input instead of appearing broken.
    if (!parsed || !/^https?:$/.test(parsed.protocol)) {
        url = 'https://duckduckgo.com/?q=' + encodeURIComponent(raw);
    } else {
        url = parsed.toString();
    }

    // Slight delay for button animation
    goBtn.style.transform = 'scale(0.98)';
    setTimeout(() => {
        window.location.href = url;
    }, 100);
}

goBtn.addEventListener('click', navigate);
urlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        navigate();
    }
});
