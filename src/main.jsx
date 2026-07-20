import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'

// These stylesheets existed but were never imported, so the app rendered as
// unstyled HTML. Order matters: base -> enhanced -> platform fixes.
import './styles/index.css'
import './styles/enhanced.css'
import './styles/welcome.css'
import './styles/electron.css'
import './styles/iphone-fix.css'

ReactDOM.createRoot(document.getElementById('root')).render(
    <React.StrictMode>
        <App />
    </React.StrictMode>,
)
