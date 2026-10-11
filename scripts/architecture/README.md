# Architecture gate

`npm run check:architecture` is a transitional no-growth gate. It never writes the
versioned `architecture-baseline.json`. `npm run test:architecture` executes real
checker logic on temporary source fixtures. CI invokes both on the feature branch
`feat/mind-phase8-live-integration`, main pushes, and pull requests targeting main.

## Dependency graph

TypeScript AST nodes supply import, export-from, import-equals, import-type,
literal dynamic-import, and literal require edges. TypeScript module resolution
handles relative modules, extension substitutions, directory indexes and the
repository's `@/` renderer alias. Missing local source imports fail the check;
ordinary asset imports are excluded. Nonliteral computed imports cannot be
statically resolved and require review. Package imports are outside this local
component graph. Root discovery covers `core`, `freya`, `electron`, `src`,
`shared`, `runtimes`, checker modules, and every source module reachable from them.

Core, Freya, Superapp (`electron` + `src`), Shared, and runtimes are separate
components. Cross-component source imports, including type imports, are rejected
unless the destination is Shared. Shared imports only Shared. Runtime composition
is directional: `runtimes/core` imports Core, `runtimes/freya` imports Freya, and
`runtimes/superapp` imports Superapp; runtime components do not import each other.
Implementation components cannot import runtime composition. Entry files have
no permission to compose other components. Contracts must move into Shared.

Tarjan strongly connected components identify every cyclic edge, including
type-only cycles and self imports. Legacy exceptions are exact resolved source /
destination pairs, never path prefixes, SCC names, or wildcard permissions.
Import kind is intentionally included in cycle discovery but does not alter the
pair identity: changing an excepted type import to a value import keeps its
existing dependency pair. This gate constrains topology; it does not prove process
isolation or validate the semantics of the exported contract.

## Size and dependency containers

Substantive lines are physical nonblank lines occupied by nontrivia TypeScript
tokens. Comment-only and blank lines do not count; multiline code/string token
content does. Ordinary modules have a 600-line ceiling. Assembly files have a
250-line ceiling by naming convention: `index`, `main`, `entry`, `router`, `routes`,
`assemble`, `assembly`, `bootstrap`, `composition`, delimited variants and camel
suffixes such as `presenceMain`. This is a filename rule, not semantic inference;
assembly files must follow that convention. Explicit approved wiring paths also
have 250-line limits: `freya/runtime/domains/**`, `core/runtime/{boot,shutdown}`,
and `electron/app/{windows,display,surfaces,tray,shutdown}` modules/subdirectories.
Existing oversized modules have
explicit per-file ceilings and reasons.

AST heuristics reject named context/deps/services containers typed `any`,
`Record<string, any|unknown>`, or any/unknown index signatures; local aliases and
ordinary Readonly/Partial/Required wrappers are recognized. Whole `FreyaCore`
dependencies and Partial/Required/Readonly/Pick/Omit wrappers are rejected;
use an explicit narrow port interface. A context/dependencies/services interface
with at least three named Service/Engine/Host/Runtime/Gateway/Store/Provider/Client/
Controller/Manager/Repository members is a service bag. Explicit Services or
ServiceBag types with three callbacks/methods are also rejected. Ordinary domain
DTOs, bare unknown data fields, and narrow operation ports with several methods
remain allowed. These mechanical rules cannot infer arbitrary whole-system bags,
resolve aliases imported from another module, or establish domain cohesion.
Excepted bag declarations include their normalized declaration fingerprint, so
adding a service changes the exception identity.

## Baseline lifecycle

The initial baseline records the source at commit `a07d66c` before leaf extraction.
The original Core protocol size exception remains until the following extraction
commit explicitly ratchets it away. Initial exceptions are extraction debt, not
endorsement of existing boundaries. The checker prints active exception counts;
resolved exceptions can remain in the baseline until a reviewed ratchet.

`npm run architecture:ratchet` is an explicit maintenance operation. It refuses
a failing checker result, new edge/container exceptions, new oversized files,
and increased ceilings. It removes resolved exceptions and lowers shrinking size
ceilings. It never refreshes an unchanged-engine source fingerprint. Review and
version its diff. Initial `node scripts/architecture/baseline.mjs --capture-once`
refuses an existing baseline; it is not part of runtime checking or CI.

`npm run check:architecture -- --strict` rejects all dependency, cycle and container
exceptions. Strict mode permits a size exception only for a documented existing
`engine.ts` file with the exact initially recorded content hash. Other oversized
legacy files must meet their ordinary/assembly limits. This intentionally fails
until structural extraction is complete.
