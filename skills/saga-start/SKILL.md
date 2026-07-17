---
name: saga-start
description: Start or attach a logical Saga product from the current directory, register its physical repository, persist .saga/project.json, and begin interactive product Discovery without depending on Harmess or any global control repository.
---

# Saga Start — bootstrap a product from any directory

Use this skill in the main interactive context. It may need to ask the user for
the product name and product idea.

## Goal

Resolve this directory to:

```text
logical Saga project (the whole product)
  + current physical repository binding
```

A product may later attach any number of repositories while keeping one board.

## Flow

1. Resolve the current directory and search upward for `.saga/project.json`.
2. If found, read `project_id` and `project_repository_id`, verify both through
   Saga, report the existing binding, then continue to Discovery.
3. If no manifest exists, read legacy `projectname.txt`.
   - Resolve/create that logical project with `project_resolve_by_name`.
   - Register the current directory with `repository_register`.
4. If neither file exists, ask the user for the **logical product name**.
   Do not assume the directory name is the product name.
5. Call:

   ```text
   project_resolve_by_name({name})
   repository_register({
     project_id,
     name: <current directory basename>,
     local_path: <absolute current directory>,
     role: "control",
     integration_branch: "dev"
   })
   ```

6. Create `.saga/project.json`:

   ```json
   {
     "project_id": 42,
     "project_slug": "product-name",
     "project_repository_id": 81
   }
   ```

7. Ask for the product idea and invoke `saga-kickstart` in the same main
   interactive context.
8. During Discovery/Architecture, register every additional repository with
   `repository_register`. One repository may be `planned` and have no
   `local_path` yet.
9. Once an epic exists, initialize it with `episode_status({epic_id})`.
   After a `go` decision, call
   `episode_transition({epic_id,to_stage:"formalization"})` before dispatching
   formalization tasks.

## Hard rules

- A Saga project is a product, not a directory and not a specialty.
- Never redirect a new product to Harmess unless the user explicitly names
  Harmess as that product.
- Never create one project per role.
- One executable task targets at most one product repository.
- Cross-repository work is split into repository-scoped tasks connected by
  dependencies.
- Do not overwrite an existing `.saga/project.json` whose IDs resolve to a
  different product. Report the conflict and ask the user.
- `projectname.txt` is a legacy compatibility input; `.saga/project.json` is
  the canonical binding for new products.
