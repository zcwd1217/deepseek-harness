// Mermaid diagram rendering for the Code Wiki HTML report.
// Diagram sources live in <pre class="mermaid"> blocks inside the HTML.
(function () {
  if (typeof mermaid === 'undefined') return;
  mermaid.initialize({
    startOnLoad: false,
    theme: 'neutral',
    securityLevel: 'loose',
    flowchart: { htmlLabels: true },
  });

  function render() {
    var blocks = document.querySelectorAll('pre.mermaid');
    if (!blocks.length) return;
    if (typeof mermaid.run === 'function') {
      mermaid.run({ querySelector: 'pre.mermaid' });
    } else if (typeof mermaid.init === 'function') {
      mermaid.init(undefined, blocks);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', render);
  } else {
    render();
  }
})();
