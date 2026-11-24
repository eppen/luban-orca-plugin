// `orca plugin check` renders the panel once per scenario, each with the worker on a fresh
// host. The worker starts with no conversation, so one scenario is enough.
import { defineCheck } from 'orca/testing'

export default defineCheck({
  fresh: {}
})
