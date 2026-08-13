import { Component, type ErrorInfo, type ReactNode } from 'react'

interface PanelSectionBoundaryProps {
  name: string
  children: ReactNode
}

interface PanelSectionBoundaryState {
  failed: boolean
}

/**
 * 手机面板的区块级最后防线。
 *
 * 数据错误应在各自 API 边界正常转成可见状态；这里专门兜住无法预判的渲染异常，
 * 让一个区块失效时其它控制面仍可操作。异常不会静默吞掉：浏览器控制台保留区块名、
 * 原始错误与 React 组件栈。
 */
export class PanelSectionBoundary extends Component<
  PanelSectionBoundaryProps,
  PanelSectionBoundaryState
> {
  state: PanelSectionBoundaryState = { failed: false }

  static getDerivedStateFromError(): PanelSectionBoundaryState {
    return { failed: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`[WebPanel] ${this.props.name}渲染失败`, error, info.componentStack)
  }

  private readonly retry = (): void => {
    this.setState({ failed: false })
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children

    return (
      <div
        role="alert"
        className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200"
      >
        <p className="text-sm">{this.props.name}暂时无法显示，面板其他功能仍可使用。</p>
        <button
          type="button"
          onClick={this.retry}
          className="mt-2 h-11 rounded-xl border border-amber-400 px-3 text-sm active:bg-amber-100 dark:border-amber-700 dark:active:bg-amber-900"
        >
          重试{this.props.name}
        </button>
      </div>
    )
  }
}
