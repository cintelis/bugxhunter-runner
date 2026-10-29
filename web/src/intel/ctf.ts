// CTF craft, as data: per category the first checks, the usual vulnerability or trick families,
// the tools, and the questions to ask when stuck. For the Playground's CTF coach (which has no
// shell: it tells the person what to run) and, through the agent's instructions, the Runner
// (which runs the tools itself). Challenges are in scope only when the user owns them or is
// registered for the event; the coach confirms that first (see presets.ts).

export interface CtfCategory {
  id: string;
  name: string;
  /** What to do in the first five minutes, in order. */
  first: string[];
  /** The families a challenge in this category usually turns on. */
  families: string[];
  /** The tools, with the one-liner that gets the most out of each. */
  tools: string[];
  /** Questions that unstick people. */
  stuck: string[];
  /** Security ids the category maps to, for write-ups. */
  refs: string;
}

export const CTF_CATEGORIES: CtfCategory[] = [
  {
    id: "web", name: "Web",
    first: [
      "read the page source, robots.txt, sitemap.xml, .git/, .env, backup names (index.php~, .bak, .old), and every JS bundle for routes and secrets",
      "map every parameter (query, body, cookie, header) and what each changes; note the stack from headers and error pages",
      "try the obvious on each input: a quote, {{7*7}}, ../, a URL you control, an id one off yours, a different HTTP method",
    ],
    families: [
      "injection: SQL (error, union, blind, time), NoSQL ($ne, $regex), command, SSTI ({{7*7}}, ${7*7}, Jinja2 and Twig gadget chains), XXE, LDAP",
      "access: IDOR, forced browsing, JWT (alg none, key confusion, weak secret, kid injection), session fixation, mass assignment",
      "files: LFI with wrappers (php://filter, data://, zip://), log poisoning, upload bypass (double extension, content-type, polyglot, .htaccess)",
      "client: XSS (reflected, stored, DOM, in attributes and JS strings), CSRF, prototype pollution, postMessage, open redirect",
      "server: SSRF to 127.0.0.1, 169.254.169.254 and internal names, deserialisation (PHP, Java, Python pickle, .NET), race conditions, HTTP smuggling, cache poisoning",
      "logic: coupon and quantity tricks, negative numbers, unicode normalisation, type juggling (== in PHP, 0e hashes), length limits that truncate",
    ],
    tools: [
      "curl -i -s (see the raw response), ffuf -w wordlist -u URL/FUZZ (directories, parameters, vhosts), katana (crawl), httpx (fingerprint)",
      "sqlmap -u URL --batch (once a manual probe shows injection), jwt_tool or a python one-liner for JWT, Burp or mitmproxy for a repeater",
      "python requests scripts for anything repetitive; a race needs threads or h2 single-packet",
    ],
    stuck: ["what does the challenge name or theme hint at?", "which parameter have you not fuzzed?", "does an error page or a stack trace name the framework and version?", "is the flag perhaps in a file you can read rather than a shell you must get?"],
    refs: "A01, A05, A07, A08 of OWASP Top 10:2025; API1, API3, API7; WSTG-INPV, WSTG-ATHZ, WSTG-SESS",
  },
  {
    id: "api", name: "API",
    first: ["find the spec: /swagger, /openapi.json, /graphql with introspection, /.well-known", "list every endpoint with its auth; try each without a token and with another user's id", "look at versions (/v1 vs /v2) and verbs the UI never uses"],
    families: ["BOLA and BFLA, mass assignment, excessive data in responses, GraphQL introspection, batching and aliases for brute force, nested query DoS, JWT and API-key handling, rate-limit absence on sensitive flows, SSRF through webhooks and imports"],
    tools: ["curl and a python script per endpoint, ffuf for parameters and ids, graphql-voyager or inql for schema, jwt_tool"],
    stuck: ["which object ids are predictable?", "what does the mobile or admin client call that the web client does not?", "can a write endpoint set a field you were never shown?"],
    refs: "OWASP API Security Top 10:2023; WSTG-APIT",
  },
  {
    id: "crypto", name: "Cryptography",
    first: ["identify the scheme before touching maths: key sizes, moduli, block size, IV reuse, encoding (base64, hex), any reuse across messages", "check the classics against the numbers: small e, small d, common modulus, shared primes across keys, p close to q, known plaintext", "if it is a custom scheme, find the invariant that leaks (a linear step, a predictable nonce, a padding check that returns a different error)"],
    families: ["RSA: small e with no padding (cube root), Wiener (small d), common modulus, Fermat (p near q), Hastad broadcast, partial key exposure (Coppersmith), textbook signatures", "symmetric: ECB cut-and-paste and byte-at-a-time, CBC bit-flipping and padding oracle, CTR nonce reuse (XOR of plaintexts), key reuse", "hashes: length extension (MD5, SHA-1, SHA-256), weak or unsalted hashes, collisions, HMAC misuse (hash(key||msg))", "classical: Caesar, Vigenere (Kasiski, index of coincidence), substitution (frequency), XOR with a repeating key, bacon, railfence", "number theory: discrete log with weak groups, ECC with a singular or small-order curve, invalid-curve points, LCG and Mersenne Twister state recovery, nonce reuse in ECDSA"],
    tools: ["python with pycryptodome and gmpy2, SageMath for lattices and curves, RsaCtfTool for the RSA classics, hashpump or hash_extender for length extension, CyberChef for encodings, z3 for constraint puzzles, factordb.com for a quick factor lookup"],
    stuck: ["what is the same across the samples you have?", "what happens to the ciphertext when you change one bit of the input?", "is the randomness really random (timestamp seed, reused nonce)?", "is the padding check or the error message an oracle?"],
    refs: "A04:2025 Cryptographic Failures; ASVS V11",
  },
  {
    id: "forensics", name: "Forensics and steganography",
    first: ["file, strings -n 8, exiftool, binwalk -e, xxd | head: what is it really, and what is appended, prepended or embedded", "for images: pngcheck, zsteg (PNG/BMP), steghide and stegseek (JPEG with a passphrase), check LSB planes and the alpha channel, compare dimensions in the header with the data", "for captures: tshark -r file.pcap -q -z conv,tcp, follow streams, export objects (HTTP, SMB, DNS tunnels), look at unusual protocols", "for disk and memory images: Volatility 3 (windows.pslist, cmdline, filescan, hashdump), Autopsy or sleuthkit, carve with foremost or photorec"],
    families: ["appended archives and polyglots, LSB steganography, audio spectrograms, metadata and thumbnails, deleted files and slack space, base64 in DNS or ICMP, keystrokes in USB captures, Office and PDF embedded objects, git history leaks"],
    tools: ["file, strings, exiftool, binwalk, foremost, xxd, zsteg, steghide, stegseek, pngcheck, tshark and Wireshark, Volatility 3, sleuthkit, Audacity or sox for audio, CyberChef"],
    stuck: ["have you looked at the end of the file and at what comes after the declared length?", "is there a second file inside (binwalk -e, 7z l)?", "what does the challenge text say about a password or a person?", "have you tried every channel: text, metadata, pixels, audio, timing?"],
    refs: "no OWASP category: evidence handling and data-at-rest protection (ASVS V14)",
  },
  {
    id: "reverse", name: "Reverse engineering",
    first: ["file, strings, checksec; run it in a sandbox and watch (ltrace, strace); find main and the comparison that decides success", "open in Ghidra or radare2 (aaa; afl; pdf @main); rename as you go; look for the flag check, the decryption loop, the anti-debug", "for scripts and bytecode: pyinstaller extraction and decompile (pycdc), JADX for Android, dnSpy or ILSpy for .NET, de4js or a prettifier for JavaScript"],
    families: ["string comparison with a transform (XOR, add, table), hand-rolled crypto, VM-based obfuscation, anti-debugging (ptrace, timing), packed binaries (UPX), flag built at runtime, checks that can be patched or solved with angr or z3"],
    tools: ["Ghidra, radare2 or rizin with Cutter, gdb with gef or pwndbg, ltrace, strace, angr, z3, upx -d, pycdc, JADX, dnSpy"],
    stuck: ["where is the first thing the input touches?", "can you make the check pass by patching rather than understanding?", "is the transform invertible, and can a solver do it?", "does running it with a debugger attached change behaviour?"],
    refs: "ASVS V15 Secure Coding and Architecture; Mobile M7 Insufficient Binary Protections",
  },
  {
    id: "pwn", name: "Binary exploitation",
    first: ["checksec (RELRO, canary, NX, PIE), file (static or dynamic, stripped), the libc version if given", "find the bug: overflow (gets, strcpy, scanf %s), format string (printf(buf)), use after free, integer overflow, off by one", "work out what you control and what you need: a return address, a GOT entry, a function pointer, a leak"],
    families: ["stack overflow to ret2win, ret2libc or ROP (ropper, ROPgadget, one_gadget), format string read and write, heap (tcache poisoning, fastbin dup, unsorted bin leak, house of x), SROP, ret2dlresolve, kernel and sandbox escapes in harder sets"],
    tools: ["pwntools (process, remote, ELF, ROP, cyclic, fmtstr_payload), gdb with gef or pwndbg, ropper, ROPgadget, one_gadget, patchelf and pwninit to match the libc, checksec"],
    stuck: ["what is your exact offset (cyclic)?", "what leaks (puts of a GOT entry, a format string %p chain)?", "which protection is off, and which does that remove from the problem?", "does the challenge give a libc, and does your local one match?"],
    refs: "CWE-120, CWE-134, CWE-416; ASVS V15",
  },
  {
    id: "osint", name: "OSINT",
    first: ["pin down what is known: a name, a handle, an image, a domain; then widen one hop at a time", "reverse image search and EXIF; username search across sites; WHOIS, DNS history, certificate transparency; archive.org for what was removed"],
    families: ["usernames reused across platforms, geolocation from image details, leaked documents and metadata, social graph pivots, company registries, commit history and paste sites"],
    tools: ["sherlock or maigret, exiftool, Google and Bing dorks, crt.sh, dnsdumpster, Wayback Machine, Google Earth and Street View, theHarvester"],
    stuck: ["what is the smallest unusual detail in the image or text?", "has the target used this handle elsewhere?", "what did the page look like a year ago?"],
    refs: "no OWASP category: ATT&CK Reconnaissance",
  },
  {
    id: "cloud", name: "Cloud",
    first: ["identify the provider from hostnames, headers and bucket URLs; try the metadata endpoint through any SSRF; list public buckets and their ACLs", "with any credential found: whoami (sts get-caller-identity), enumerate what it can read, look for role chains and over-broad policies"],
    families: ["public or listable storage, metadata credentials via SSRF, over-privileged roles and assume-role chains, secrets in user data and environment, exposed serverless endpoints, misconfigured OIDC trust, Kubernetes service-account tokens and dashboards"],
    tools: ["aws, az and gcloud CLIs, pacu, enumerate-iam, s3scanner, kube-hunter and kubectl, ScoutSuite"],
    stuck: ["what does the credential's own policy let it do?", "which service trusts which role?", "is there a public resource whose name you can guess from the company name?"],
    refs: "A01:2025, A02:2025; API7:2023 SSRF; ASVS V13",
  },
  {
    id: "ai", name: "AI and LLM",
    first: ["learn the system: what it was told (ask it to summarise its instructions), what tools it has, what it can read (files, URLs, other users' data), what checks its output", "classify the challenge: extract a secret from the prompt, make it call a tool, make it read content you control, bypass a guardrail, poison its memory or retrieval"],
    families: ["direct injection and jailbreak framings (role-play, translation, continuation, hypothetical, format tricks): AML.T0051.000 and AML.T0054", "indirect injection through a document, web page, image or tool result the model reads: AML.T0051.001, AML.T0070 RAG poisoning", "system prompt extraction (ask for it in another language, as code, as a poem, piecewise): AML.T0056 and AML.T0069", "exfiltration through rendering (markdown image URLs that carry data), tool invocation or links: AML.T0077 and AML.T0086", "obfuscation to pass a filter (encodings, homoglyphs, splitting, payload in a code block): AML.T0068", "memory and context poisoning across turns or sessions: AML.T0080; tool poisoning and malicious tool definitions: AML.T0110", "guardrail evasion of input and output classifiers; model extraction and membership inference on inference APIs: AML.T0024"],
    tools: ["a notebook of your attempts with exact prompts and responses, promptfoo and garak for systematic probes against your own endpoint, CyberChef for encodings"],
    stuck: ["what does the model see that you do not (system prompt, tool results, retrieved text)?", "which channel is unfiltered: input, retrieval, tool output, rendering?", "can the model be made to do the step for you (write the code, summarise the secret) instead of revealing it directly?"],
    refs: "OWASP LLM01, LLM02, LLM05, LLM06, LLM07, LLM08; ASI01, ASI02, ASI06; MITRE ATLAS AML.T0051, AML.T0054, AML.T0056, AML.T0057, AML.T0068, AML.T0070, AML.T0077, AML.T0080, AML.T0086",
  },
  {
    id: "misc", name: "Misc and scripting",
    first: ["read the whole challenge text twice; note the flag format; connect to the service and see what it says before sending anything", "if it is a game or a puzzle, write a client and automate; if it is a jail (Python, bash, SQL), list what characters and names are allowed"],
    families: ["Python jails (builtins, attribute walking, format string, unicode), bash jails (globbing, $0, env), esoteric languages, QR and barcode layers, encodings stacked (base64, base32, hex, rot, morse, brainfuck), protocol puzzles over nc"],
    tools: ["pwntools remote for sockets, CyberChef magic, dcode.fr for classical ciphers, zbarimg for QR, a quick python script for anything repetitive"],
    stuck: ["what is the flag format, and what in the output already looks like it?", "what does the service do with input it does not expect?", "which characters are blocked, and what can be built from the rest?"],
    refs: "A05:2025 Injection; ASVS V1 and V2",
  },
];

/** What to do with any challenge file or service before thinking about the category. */
export const CTF_FIRST_LOOK = `First look, for any challenge:
1. Read the challenge text, name and category twice; write down the flag format and every hint.
2. For a file: file, strings -n 8, exiftool, binwalk, xxd | head and tail; a hash lookup if it looks like a known file; list archives with 7z l. Keep the original untouched; work on a copy.
3. For a service: connect once and read what it prints; note the protocol and the prompts before sending anything.
4. For a URL: source, robots.txt, the JS bundles, the headers and the error page; map parameters.
5. Name the category and the two or three families most likely; write the next three experiments, cheapest first.
6. Keep a notes file: every attempt, exact input, exact output. When stuck, read it back and ask the stuck questions for the category.`;

const section = (c: CtfCategory) =>
  `${c.name} (${c.id}):\n- first: ${c.first.join("; ")}\n- families: ${c.families.join(" | ")}\n- tools: ${c.tools.join("; ")}\n- when stuck: ${c.stuck.join(" ")}\n- refs: ${c.refs}`;

/** The whole CTF playbook as prompt text. */
export const ctfBrief = () => `${CTF_FIRST_LOOK}\n\nBy category:\n${CTF_CATEGORIES.map(section).join("\n\n")}`;
