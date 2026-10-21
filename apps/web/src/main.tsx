import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from '../../desktop/src/renderer/src/App'
import '../../desktop/src/renderer/src/styles.css'
import { installLearningBridge } from './bridge'

installLearningBridge()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
