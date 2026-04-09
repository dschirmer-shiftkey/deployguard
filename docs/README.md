# DeployGuard — Documentation

This directory contains supplementary documentation for DeployGuard.

## Product Specifications (in Komatik monorepo)

The full product brief, technical spec, and architectural decisions live in the
Komatik monorepo:

- **Product Brief**: [`Komatik/docs/products/deployguard/PRODUCT_BRIEF.md`](https://github.com/dschirmer-shiftkey/Komatik/tree/dev/docs/products/deployguard/PRODUCT_BRIEF.md)
- **Technical Spec**: [`Komatik/docs/products/deployguard/TECHNICAL_SPEC.md`](https://github.com/dschirmer-shiftkey/Komatik/tree/dev/docs/products/deployguard/TECHNICAL_SPEC.md)
- **Decisions**: [`Komatik/docs/products/deployguard/DECISIONS.md`](https://github.com/dschirmer-shiftkey/Komatik/tree/dev/docs/products/deployguard/DECISIONS.md)

## Key Decisions

- **ADR-DG-001**: GitHub Action as primary distribution (vs. standalone CI service)
- **ADR-DG-002**: Fail-open by default (vs. fail-closed)
