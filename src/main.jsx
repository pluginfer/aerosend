import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'

// One design system, themed light/dark. Replaces the five overlapping
// stylesheets that used to fight each other (and were never imported).
import './styles/theme.css'

ReactDOM.createRoot(document.getElementById('root')).render(
    <React.StrictMode>
        <App />
    </React.StrictMode>,
)
