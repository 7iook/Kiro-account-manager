/**
 * 局域网可达地址的分类与排序 —— 纯函数，无 I/O。
 *
 * ## 为什么需要这一层
 *
 * `os.networkInterfaces()` 在真实 Windows 开发机上会吐出一堆**手机连不上**的
 * IPv4。本机实测 8 条 IPv4，只有 1 条是手机真能访问的无线网卡：
 *
 *   WLAN                              192.168.31.28    f4:ce:23:…  ← 唯一真实局域网
 *   Tailscale                         100.102.246.52   00:00:00:…  隧道
 *   VMware Network Adapter VMnet1     192.168.171.1    00:50:56:…  虚拟机
 *   VMware Network Adapter VMnet8     192.168.239.1    00:50:56:…  虚拟机
 *   vEthernet (Default Switch)        172.19.96.1      00:15:5d:…  Hyper-V
 *   vEthernet (WSL (Hyper-V …))       172.23.240.1     00:15:5d:…  WSL
 *   Loopback Pseudo-Interface 1       114.132.125.146  internal    ★ 公网 IP 形态但不可达
 *   Loopback Pseudo-Interface 1       127.0.0.1        internal    回环
 *
 * 把这 6 条非回环地址平铺给用户，等于让他从 6 个里瞎猜哪个能扫。
 *
 * ★ 那条 `114.132.125.146` 是这里最容易踩的坑：它长得像公网 IP，却挂在
 * Loopback 上。**所以 `internal` 必须先过滤，不能只按网段判断** ——
 * 「非私有网段就排除」的规则会把它当成有效公网地址放进列表。
 *
 * ## 判据为什么不用网段
 *
 * `172.23.240.1`（WSL）和 `192.168.171.1`（VMware）都落在合法私有网段里，
 * 与真实局域网地址在网段上无法区分。可靠的判据是 **MAC OUI + 网卡名**：
 * 虚拟网卡厂商的 OUI 是固定分配的，隧道口没有真实 MAC（全零）。
 *
 * 参照实现 `codeg-research/src-tauri/src/web/mod.rs:417` 的 `is_advertisable_ipv4`
 * **只**做了「非回环 / 非 link-local / 非 unspecified」三条，不区分虚拟网卡 ——
 * 它在这台机器上同样会平铺 6 条。所以这套分类判据是本仓自建的，不是照搬。
 *
 * ## 降级姿势（重要）
 *
 * OUI 表不可能覆盖所有硬件。若判据认不出任何「真实物理网卡」，**不产出空的
 * 推荐分组**，而是退回「全部平铺、不标推荐」（`classifyAddresses` 的
 * `degraded` 标记）。失败代价不对称：排序不佳只是体验问题，而滤掉唯一可用
 * 地址会让用户没有地址可选 —— 那是硬故障。
 */

/** 一条候选地址的分类结果 */
export interface ClassifiedAddress {
  /** 完整可用 URL（含 /panel 前缀与端口）—— 展示文本与二维码内容都用这一个字符串 */
  url: string
  /** 主机部分（IP），用于「按 host 记住用户选择」，换端口后选择依然有效 */
  host: string
  /** 网卡名（原样，便于用户辨认） */
  interfaceName: string
  /** 分类 */
  kind: 'loopback' | 'physical' | 'virtual'
  /**
   * 虚拟网卡的来源标注。`kind === 'virtual'` 时给出，认不出的为 'other'。
   * 用于 UI 上把「其他地址」分组里的每一项标明出处，而不是让用户面对裸 IP。
   */
  virtualSource?: 'wsl' | 'hyperv' | 'vmware' | 'virtualbox' | 'tailscale' | 'other'
}

export interface AddressClassification {
  /** 推荐给手机用的地址（真实物理网卡）。降级时为空 */
  recommended: ClassifiedAddress[]
  /** 虚拟网卡 / 隧道地址，UI 应折叠 */
  virtual: ClassifiedAddress[]
  /** 回环地址（本机自测用，手机扫无意义） */
  loopback: ClassifiedAddress[]
  /**
   * true 表示判据没认出任何物理网卡，UI 应退回「全部平铺、不标推荐」。
   * 此时 `recommended` 为空而 `virtual` 可能非空 —— 别把 virtual 当不可用。
   */
  degraded: boolean
}

/** 主机上一张网卡的一条 IPv4 地址（`os.networkInterfaces()` 的子集，便于测试注入） */
export interface RawInterfaceAddress {
  interfaceName: string
  address: string
  family: 'IPv4' | 'IPv6'
  internal: boolean
  mac: string
  /**
   * 子网掩码。/32（`255.255.255.255`）= 单地址子网，隧道口特征
   * （本机 Tailscale 就是这样）—— 不可能是一个能容纳手机的局域网。
   * 可缺：旧 fixture 不带此字段时不影响分类结果。
   */
  netmask?: string
}

/** 虚拟网卡厂商 OUI（MAC 前三段，小写）→ 来源标注 */
const VIRTUAL_OUI: Record<string, NonNullable<ClassifiedAddress['virtualSource']>> = {
  '00:50:56': 'vmware',
  '00:0c:29': 'vmware',
  '00:05:69': 'vmware',
  '00:1c:14': 'vmware',
  '00:15:5d': 'hyperv',
  '08:00:27': 'virtualbox',
  '0a:00:27': 'virtualbox'
}

/** 网卡名特征（小写子串）→ 来源标注。OUI 认不出时的第二判据 */
const VIRTUAL_NAME_HINTS: Array<[string, NonNullable<ClassifiedAddress['virtualSource']>]> = [
  ['wsl', 'wsl'],
  ['vethernet', 'hyperv'],
  ['hyper-v', 'hyperv'],
  ['vmnet', 'vmware'],
  ['vmware', 'vmware'],
  ['virtualbox', 'virtualbox'],
  ['vboxnet', 'virtualbox'],
  ['tailscale', 'tailscale'],
  ['zerotier', 'other'],
  ['wireguard', 'other'],
  ['hamachi', 'other'],
  ['loopback', 'other']
]

/** link-local：169.254.0.0/16，不可路由，列出来只会误导 */
function isLinkLocal(address: string): boolean {
  return address.startsWith('169.254.')
}

/** 全零 MAC = 没有真实链路的隧道口 / 伪接口（Tailscale、Loopback 都是这样） */
function hasNoRealMac(mac: string): boolean {
  return mac === '' || /^00:00:00:00:00:00$/i.test(mac)
}

/**
 * 判定一条地址属于哪种网卡，并给出虚拟来源标注。
 *
 * 判定顺序：**先网卡名，再 OUI**，最后全零 MAC（隧道口）。
 *
 * 名字优先于 OUI 是实测结论，不是随意排的：WSL 的网卡
 * `vEthernet (WSL (Hyper-V firewall))` 用的是 Hyper-V 的 OUI `00:15:5d`
 * （WSL2 本身跑在 Hyper-V 上）。先看 OUI 会把它标成 "Hyper-V"，而用户认得的
 * 是 "WSL" —— 标错来源等于没标。名字更具体时以名字为准。
 *
 * 反过来，名字被用户改过时 OUI 兜底（`classifyOne` 的 OUI 分支仍然保留），
 * 两条判据互补：任一命中即为 virtual，只是来源标注取更具体的那个。
 */
export function classifyOne(
  entry: RawInterfaceAddress
): { kind: ClassifiedAddress['kind']; virtualSource?: ClassifiedAddress['virtualSource'] } {
  if (entry.internal) return { kind: 'loopback' }

  const name = entry.interfaceName.toLowerCase()
  for (const [hint, source] of VIRTUAL_NAME_HINTS) {
    if (name.includes(hint)) return { kind: 'virtual', virtualSource: source }
  }

  const oui = entry.mac.toLowerCase().split(':').slice(0, 3).join(':')
  const byOui = VIRTUAL_OUI[oui]
  if (byOui !== undefined) return { kind: 'virtual', virtualSource: byOui }

  // 全零 MAC 最后判：没有真实链路的隧道口 / 伪接口
  if (hasNoRealMac(entry.mac)) return { kind: 'virtual', virtualSource: 'other' }

  return { kind: 'physical' }
}

/**
 * 把网卡地址列表分类 + 排序，组装成可直接渲染的分组。
 *
 * @param entries 原始网卡地址（IPv6 / link-local 会在内部剔除）
 * @param buildUrl 由 host 生成完整 URL —— URL 拼装（端口 + /panel 前缀）留给调用方，
 *                 保证展示文本与二维码内容出自同一处
 */
export function classifyAddresses(
  entries: RawInterfaceAddress[],
  buildUrl: (host: string) => string
): AddressClassification {
  const recommended: ClassifiedAddress[] = []
  const virtual: ClassifiedAddress[] = []
  const loopback: ClassifiedAddress[] = []
  const seen = new Set<string>()

  for (const entry of entries) {
    if (entry.family !== 'IPv4') continue
    if (isLinkLocal(entry.address)) continue
    if (entry.address === '0.0.0.0') continue
    if (seen.has(entry.address)) continue
    seen.add(entry.address)

    const { kind, virtualSource } = classifyOne(entry)
    const item: ClassifiedAddress = {
      url: buildUrl(entry.address),
      host: entry.address,
      interfaceName: entry.interfaceName,
      kind,
      ...(virtualSource !== undefined ? { virtualSource } : {})
    }

    if (kind === 'physical') recommended.push(item)
    else if (kind === 'virtual') virtual.push(item)
    else loopback.push(item)
  }

  const byHost = (a: ClassifiedAddress, b: ClassifiedAddress): number =>
    a.host.localeCompare(b.host, undefined, { numeric: true })
  recommended.sort(byHost)
  virtual.sort(byHost)
  loopback.sort(byHost)

  return {
    recommended,
    virtual,
    loopback,
    // 有非回环地址却一个物理网卡都没认出来 → 判据失效，UI 退回平铺
    degraded: recommended.length === 0 && virtual.length > 0
  }
}

/**
 * 选默认展示 / 二维码地址。
 *
 * 优先级：用户上次选的 host（按 host 记忆，换端口仍有效）→ `probedHost`
 * （通外网的那张网卡，由调用方用 UDP-connect 探默认路由得到）→ 推荐组首个
 * → 虚拟组首个 → 回环首个。
 *
 * 为什么 probedHost 排在推荐组之前：降级时推荐组是空的，而「哪张网卡通外网」
 * 是比 OUI 更直接的可达性证据（移植自 codeg-research `mod.rs:449-462` 的
 * enumeration-为空兜底思路）。非降级时它通常与推荐组首个一致。
 */
export function pickDefaultAddress(
  classification: AddressClassification,
  opts: { savedHost?: string | null; probedHost?: string | null } = {}
): ClassifiedAddress | null {
  const all = [
    ...classification.recommended,
    ...classification.virtual,
    ...classification.loopback
  ]
  if (all.length === 0) return null

  if (opts.savedHost != null) {
    const saved = all.find((a) => a.host === opts.savedHost)
    if (saved !== undefined) return saved
  }
  if (opts.probedHost != null) {
    const probed = all.find((a) => a.host === opts.probedHost)
    if (probed !== undefined) return probed
  }
  return all[0]
}
