import { parse } from 'yaml'

import { ProxyGroup } from '@/enums/kernel'
import { Readfile, Writefile } from '@/bridge'
import { deepClone, APP_TITLE, deepAssign, stringifyNoFolding } from '@/utils'
import { CoreConfigFilePath } from '@/constant/kernel'
import { type ProfileType, useSubscribesStore, useRulesetsStore, usePluginsStore } from '@/stores'

export const generateRule = (
  rule: ProfileType['rulesConfig'][0],
  proxyGruoups?: ProfileType['proxyGroupsConfig']
) => {
  const {
    type,
    payload,
    proxy,
    'no-resolve': noResolve,
    'ruleset-type': rulesetType,
    'ruleset-name': rulesetName
  } = rule
  let ruleStr = type
  let proxyStr = proxy
  if (type !== 'MATCH') {
    if (type === 'RULE-SET') {
      if (rulesetType === 'file') {
        const rulesetsStore = useRulesetsStore()
        const ruleset = rulesetsStore.getRulesetById(payload)
        if (ruleset) {
          ruleStr += ',' + ruleset.name
        }
      } else if (rulesetType === 'http') {
        ruleStr += ',' + rulesetName
      }
    } else if (type === 'LOGIC') {
      ruleStr = payload
    } else {
      ruleStr += ',' + payload
    }
  }

  if (proxyGruoups) {
    const group = proxyGruoups.find((v) => v.id === proxy)
    if (group) {
      proxyStr = group.name
    }
  }

  ruleStr += ',' + proxyStr

  const supportNoResolve = [
    'GEOIP',
    'IP-CIDR',
    'IP-CIDR6',
    'SCRIPT',
    'RULE-SET',
    'IP-ASN'
  ].includes(type)

  if (noResolve && supportNoResolve) {
    ruleStr += ',no-resolve'
  }
  return ruleStr
}

type ProxiesType = { type: string; name: string }

export const generateProxies = async (groups: ProfileType['proxyGroupsConfig']) => {
  const subscribesStore = useSubscribesStore()

  const subIDsMap = new Set(
    groups.reduce(
      (p, c) => [
        ...p,
        ...c.proxies.filter(({ type }) => type !== 'Built-In').map(({ type }) => type)
      ],
      [] as string[]
    )
  )

  const proxyMap: Record<string, ProxiesType[]> = {}

  for (const subID of subIDsMap) {
    const sub = subscribesStore.getSubscribeById(subID)
    if (sub) {
      try {
        const subStr = await Readfile(sub.path)
        const { proxies = [] } = parse(subStr)
        proxyMap[sub.id] = proxies
      } catch (error) {
        console.log(error)
      }
    }
  }

  const proxies = groups.reduce((p, c) => [...p, ...c.proxies], [] as ProxiesType[])

  const proxiesList: any = []

  proxies.forEach(({ type, name }) => {
    if (proxyMap[type]) {
      const proxy = proxyMap[type].find((v) => v.name === name)
      if (proxy) {
        const isExist = proxiesList.find((v: any) => v.name === proxy.name)
        !isExist && proxiesList.push(proxy)
        // TODO: Handle proxy with the same name
        // No processing required, can be implemented using proxy prefixes
      }
    }
  })

  return proxiesList
}

export const generateProxyGroup = (
  proxyGruoup: ProfileType['proxyGroupsConfig'][0],
  groups: ProfileType['proxyGroupsConfig']
) => {
  const {
    type,
    name,
    url,
    proxies,
    use,
    interval,
    strategy,
    tolerance,
    lazy,
    'disable-udp': disableUDP,
    filter,
    'exclude-filter': ExcludeFilter,
    hidden,
    icon
  } = proxyGruoup

  const group: any = { name, type, filter, 'exclude-filter': ExcludeFilter, hidden, icon }

  if (use.length !== 0) {
    group.use = use
  }

  if (proxies.length !== 0) {
    group.proxies = proxies.map((v) => {
      if (['DIRECT', 'REJECT', 'PASS'].includes(v.id)) {
        return v.name
      }
      const group = groups.find((vv) => vv.id === v.id)
      if (group) {
        return group.name
      }
      return v.name
    })
  }

  if (type === ProxyGroup.Select) {
    Object.assign(group, {
      'disable-udp': disableUDP
    })
  } else if (type === ProxyGroup.UrlTest) {
    Object.assign(group, {
      url,
      interval,
      tolerance,
      lazy,
      'disable-udp': disableUDP
    })
  } else if (type === ProxyGroup.Fallback) {
    Object.assign(group, {
      url,
      interval,
      lazy,
      'disable-udp': disableUDP
    })
  } else if (type === ProxyGroup.LoadBalance) {
    Object.assign(group, {
      url,
      interval,
      lazy,
      'disable-udp': disableUDP,
      strategy
    })
  } else if (type === ProxyGroup.Relay) {
    Object.assign(group, {})
  }

  return group
}

export const generateProxyProviders = async (groups: ProfileType['proxyGroupsConfig']) => {
  const providers: Record<string, any> = {}
  const subs = new Set<string>()
  groups.forEach((group) => {
    group.use.forEach((use) => subs.add(use))
  })
  const subscribesStore = useSubscribesStore()
  subs.forEach((id) => {
    const sub = subscribesStore.getSubscribeById(id)
    if (sub) {
      providers[sub.id] = {
        type: 'file',
        path: sub.path.replace('data/', '../')
      }
      if (sub.healthCheck.enable) {
        providers[sub.id]['health-check'] = {
          enable: true,
          url: sub.healthCheck.url || 'https://www.gstatic.com/generate_204',
          interval: sub.healthCheck.interval || 300
        }
      }
    }
  })

  return providers
}

const generateRuleProviders = async (
  dns: ProfileType['dnsConfig'],
  rules: ProfileType['rulesConfig'],
  proxyGruoups: ProfileType['proxyGroupsConfig']
) => {
  const rulesetsStore = useRulesetsStore()
  const providers: Record<string, any> = {}

  function appendLocalProvider(name: string) {
    const ruleset = rulesetsStore.getRulesetById(name) || rulesetsStore.getRulesetByName(name)
    if (ruleset) {
      providers[ruleset.name] = {
        type: 'file',
        behavior: ruleset.behavior,
        path: ruleset.path.replace('data/', '../'),
        format: ruleset.format
      }
    }
  }

  rules
    .filter((rule) => rule.type === 'RULE-SET')
    .forEach((rule) => {
      if (rule['ruleset-type'] === 'file') {
        appendLocalProvider(rule.payload)
      } else {
        const group = proxyGruoups.find((v) => v.id === rule['ruleset-proxy'])
        providers[rule['ruleset-name']] = {
          type: 'http',
          url: rule.payload,
          behavior: rule['ruleset-behavior'],
          format: rule['ruleset-format'],
          proxy: group?.name || 'DIRECT'
        }
      }
    })

  const l1 = dns['fake-ip-filter'].flatMap((v) => (v.startsWith('rule-set:') ? v.substring(9) : []))
  const l2 = Object.keys(dns['nameserver-policy']).flatMap((key) =>
    key.startsWith('rule-set:') ? key.substring(9).split(',') : []
  )

  l1.concat(l2).forEach((name) => appendLocalProvider(name))

  return providers
}

/**
  Processing steps
  1. Generate the config from the profile.
  2. Merge the config using mixins.
  3. Process the config using scripts.
  4. Process the config using plugins.
 */
export const generateConfig = async (originalProfile: ProfileType) => {
  const profile = deepClone(originalProfile)

  const config: Record<string, any> = {
    ...profile.generalConfig,
    ...profile.advancedConfig,
    tun: profile.tunConfig,
    dns: profile.dnsConfig,
    hosts: {}
  }

  // step 1
  if (!config.dns.listen) {
    delete config.dns.listen
  }

  if (config.dns['default-nameserver'].length === 0) {
    delete config.dns['default-nameserver']
  }

  if (config.dns['nameserver'].length === 0) {
    delete config.dns['nameserver']
  }

  Object.entries<string>(config.dns['hosts']).forEach(([key, value]) => {
    const _value = value.split(',')
    config.hosts[key] = _value.length === 1 ? _value[0] : _value
  })
  delete config.dns['hosts']

  if (config.dns['fallback'].length === 0) {
    delete config.dns['fallback']
    delete config.dns['fallback-filter']
  }

  if (config.dns['proxy-server-nameserver'].length === 0) {
    delete config.dns['proxy-server-nameserver']
  }

  Object.entries(config.dns['nameserver-policy']).forEach(([key, value]: any) => {
    const _value = value.split(',')
    config.dns['nameserver-policy'][key] = _value.length === 1 ? _value[0] : _value
  })

  config['proxy-providers'] = await generateProxyProviders(profile.proxyGroupsConfig)

  config['rule-providers'] = await generateRuleProviders(
    profile.dnsConfig,
    profile.rulesConfig,
    profile.proxyGroupsConfig
  )

  config['proxies'] = await generateProxies(profile.proxyGroupsConfig)

  config['proxy-groups'] = profile.proxyGroupsConfig.map((proxyGruoup) =>
    generateProxyGroup(proxyGruoup, profile.proxyGroupsConfig)
  )

  config['rules'] = profile.rulesConfig
    .filter(({ type }) => profile.advancedConfig['geodata-mode'] || !type.startsWith('GEO'))
    .map((rule) => generateRule(rule, profile.proxyGroupsConfig))

  // step 2
  const { priority, config: mixin } = originalProfile.mixinConfig
  if (priority === 'mixin') {
    deepAssign(config, parse(mixin))
  } else if (priority === 'gui') {
    deepAssign(config, deepAssign(parse(mixin), config))
  }

  // step 3
  const fn = new window.AsyncFunction(
    `${profile.scriptConfig.code};return await onGenerate(${JSON.stringify(config)})`
  )
  let _config
  try {
    _config = await fn()
  } catch (error: any) {
    throw error.message || error
  }

  if (typeof _config !== 'object') {
    throw 'Wrong result'
  }

  // step 4
  const pluginsStore = usePluginsStore()
  const result = await pluginsStore.onGenerateTrigger(_config, originalProfile)

  return result
}

export const generateConfigFile = async (profile: ProfileType) => {
  const header = `# DO NOT EDIT - Generated by ${APP_TITLE}\n`

  const config = await generateConfig(profile)

  config['log-level'] = 'info'

  await Writefile(CoreConfigFilePath, header + stringifyNoFolding(config))
}
