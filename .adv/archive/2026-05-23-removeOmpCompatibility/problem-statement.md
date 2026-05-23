# Problem Statement

`opencode-model-routing` has successfully moved to OMR as the product boundary, but legacy OMP compatibility remains visible in code, build targets, docs, naming, and external/local repositories.

This creates ambiguity for users and maintainers: two names and two apparent products exist even though only OMR should remain supported. The cleanup must remove active OMP surfaces while preserving historical records and proving that current OMR behavior still works.