# Third-party notices

The web application includes the following locally bundled libraries. Their license texts are retained alongside the distributed files:

| Library | Version | Bundled file | License text |
| --- | --- | --- | --- |
| DOMPurify | 3.4.17 | web/vendor/purify.min.js | [Apache-2.0 license](web/vendor/dompurify.LICENSE) |
| markdown-it | 15.0.3 | web/vendor/markdown-it.umd.min.js | [MIT license](web/vendor/markdown-it.LICENSE) |
| highlight.js | 11.12.0 | web/vendor/highlight.min.js | [BSD-3-Clause license](web/vendor/highlight.LICENSE) |
| Mermaid Tiny | 12.3.0 | web/vendor/mermaid.tiny.js | [MIT license](web/vendor/mermaid.LICENSE) |

Other runtime and development dependencies are declared in package.json and pinned in package-lock.json; their respective licenses apply. This notice does not grant a license to Agent Relay's own source code.

The local bridge uses [werift](https://github.com/shinyoshiaki/werift-webrtc) 0.26.0 (MIT) for WebRTC ICE/DTLS/SCTP data channels. Its license and those of its dependencies are distributed by npm in their respective packages.

The relay uses [sharp](https://sharp.pixelplumbing.com/) (Apache-2.0, version pinned in package.json) and its packaged libvips dependencies to generate cached image previews. Their license notices are distributed in the npm packages.

The optional desktop manager uses [Electron](https://www.electronjs.org/) (MIT, version pinned in package.json). Its runtime, Chromium, and other third-party licenses are supplied with the installed Electron distribution. Desktop binaries are not vendored in this repository.
