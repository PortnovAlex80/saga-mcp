# Campaign Draft — {{campaign.subject}}

> Template pinned by the `lm-marketing@1.0.0` package
> (`marketing-author` execution profile). A worker fills this in to produce a
> typed `CampaignDraft` artifact from a `MarketingBrief`.

## Brief

- **Audience:** {{campaign.audience}}
- **Goal:** {{campaign.goal}}
- **Channels:** {{campaign.channels}}
- **Key message:** {{campaign.keyMessage}}
- **Constraints:** {{campaign.constraints}}

## Draft

### Subject line / headline

{{campaign.subject}}

### Body

{{draft.body}}

### Channel plan

{{draft.channelPlan}}

### Call to action

{{draft.callToAction}}

## Self-check

Before submitting, every `{{campaign.*}}` placeholder above must be replaced
with a concrete value sourced from the brief, and every `{{draft.*}}` field must
be filled. See `campaign-draft-checklist.md`.
