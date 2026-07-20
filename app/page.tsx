const navigationItems = ["工作台", "作业管理", "班级", "设置"];

export default function Home() {
  return (
    <main className="teacher-workbench">
      <aside className="sidebar" aria-label="主导航">
        <div className="brand" aria-label="AI 作业批改助手">
          <span className="brand-mark" aria-hidden="true">
            ✦
          </span>
          <span>AI 作业批改助手</span>
        </div>
        <nav>
          <ul className="navigation-list">
            {navigationItems.map((item, index) => (
              <li key={item}>
                <span
                  className={index === 0 ? "navigation-item active" : "navigation-item"}
                >
                  {item}
                </span>
              </li>
            ))}
          </ul>
        </nav>
        <p className="sidebar-note">让反馈更及时，让教学更从容。</p>
      </aside>

      <section className="workspace" aria-labelledby="workbench-title">
        <header className="topbar">
          <div>
            <p className="eyebrow">上午好，老师</p>
            <h1>AI 作业批改助手</h1>
          </div>
          <div className="avatar" aria-label="教师头像">
            师
          </div>
        </header>

        <div className="dashboard-intro">
          <div>
            <p className="eyebrow">教学管理</p>
            <h2 id="workbench-title">教师工作台</h2>
            <p>作业批改、班级管理与教学反馈将在这里逐步呈现。</p>
          </div>
          <span className="status-pill">系统准备就绪</span>
        </div>

        <section className="empty-state" aria-label="工作台初始化状态">
          <span className="empty-state-icon" aria-hidden="true">
            ✓
          </span>
          <h3>欢迎来到你的教学空间</h3>
          <p>基础工作台已创建，后续功能将在此衔接。</p>
        </section>
      </section>
    </main>
  );
}
