// Beer 业务面板（customFrame 整页布局 + 紧凑顶栏）。手写单文件，不需要构建；
// 只 require 宿主共享的 react。布局以 docs/layouts/v3.html 为准。
window.__ModuleLoader__.load({
  id: 'beer-workbench',
  factory: require => {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useRef, useCallback } = React
    const API = '/api/beer'
    let hostCtx = null

    const CSS = `
.beer{--bg:#f3efe8;--paper:#fbf8f3;--line:#e6dfd4;--ink:#2b2621;--ink2:#6f665c;--ink3:#a39a8f;--accent:#d9694a;--accent-soft:#fbe7df;--accent-ink:#b4482b;--bad:#c0463b;--bad-soft:#f8e1de;
  position:relative;flex:1;min-width:0;min-height:0;display:flex;flex-direction:column;background:var(--paper);color:var(--ink);font:14px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC","Hiragino Sans GB",sans-serif;overflow:hidden}
.beer *{box-sizing:border-box}
.beer-top{position:sticky;top:0;z-index:3;display:flex;gap:8px;align-items:center;padding:8px 14px;border-bottom:1px solid var(--line);background:var(--paper);min-width:0;flex-wrap:wrap}
.beer-ttl{font-weight:700;font-size:15px;white-space:nowrap}
.beer-search{flex:0 1 260px;min-width:120px;border:1px solid var(--line);border-radius:8px;background:#fff;padding:4px 10px;color:var(--ink);font:inherit;font-size:13px}
.beer-search::placeholder{color:var(--ink3)}
.beer-search:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 2px var(--accent-soft)}
.beer-vault{margin-left:auto;display:flex;gap:6px;align-items:center;min-width:0;font-size:12px;color:var(--ink2)}
.beer-vault span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:260px}
.beer-btn{border:1px solid var(--line);background:#fff;border-radius:7px;padding:3px 10px;font:inherit;font-size:12px;color:var(--ink);cursor:pointer;white-space:nowrap}
.beer-btn.pri{background:var(--accent);border-color:var(--accent);color:#fff}
.beer-btn.ghost{background:transparent;border-color:transparent;color:var(--ink2)}
.beer-btn:disabled{opacity:.6;cursor:default}
.beer-body{flex:1;display:flex;min-height:0;min-width:0}
.beer-biz{flex:1;display:flex;flex-direction:column;min-width:0;min-height:0}
.beer-tabs{display:flex;gap:1px;padding:6px 12px 0;border-bottom:1px solid var(--line);overflow-x:auto;flex:none}
.beer-tab{padding:6px 11px;border:1px solid transparent;border-radius:8px 8px 0 0;background:transparent;color:var(--ink2);white-space:nowrap;font:inherit;cursor:pointer}
.beer-tab.on{background:#fff;border-color:var(--line);border-bottom-color:#fff;margin-bottom:-1px;color:var(--ink);font-weight:600}
.beer-tabs-sep{width:1px;height:18px;background:var(--line);margin:0 6px 7px;flex:none;align-self:flex-end}
.beer-tab-add{padding:6px 11px;border:1px dashed var(--line);border-radius:8px 8px 0 0;background:transparent;color:var(--ink3);font:inherit;cursor:pointer}
.beer-tab-add:hover{color:var(--accent-ink);border-color:var(--accent)}
.beer-tab-form{display:flex;flex-wrap:wrap;gap:8px 10px;align-items:flex-end;padding:10px 14px;border-bottom:1px solid var(--line);background:var(--bg);flex:none}
.beer-tab-form label{display:flex;flex-direction:column;gap:2px;font-size:12px;color:var(--ink2)}
.beer-tab-form input,.beer-tab-form select{border:1px solid var(--line);border-radius:7px;background:#fff;padding:4px 8px;font:inherit;font-size:13px;color:var(--ink);min-width:160px}
.beer-tab-form .acts{display:flex;gap:6px;margin-left:auto}
.beer-tab-form .beer-err{flex-basis:100%;margin:0}
.beer-tab-form .beer-muted{flex-basis:100%}
.beer-custom-bar{display:flex;align-items:center;gap:8px;margin-bottom:12px;font-size:12px;color:var(--ink2);min-width:0}
.beer-custom-bar span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.beer-custom-bar .beer-btn{margin-left:auto;flex:none}
.beer-grid-view{display:flex;flex-direction:column;gap:12px;min-width:0}
.beer-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px}
.beer-tile{border:1px solid var(--line);border-radius:10px;background:#fff;padding:10px 12px;text-align:left;font:inherit;color:var(--ink);cursor:pointer;min-width:0}
.beer-tile:hover{border-color:var(--accent);background:var(--accent-soft)}
.beer-tile.on{border-color:var(--accent);background:var(--accent-soft);color:var(--accent-ink)}
.beer-tile b{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.beer-tile small{color:var(--ink3);font-size:11px}
.beer-tile:disabled{opacity:.55;cursor:default}
.beer-tile:disabled:hover{border-color:var(--line);background:#fff}
.beer-content{flex:1;overflow:auto;padding:16px 18px;min-width:0}
.beer-card{border:1px solid var(--line);border-radius:12px;background:#fff;padding:14px 16px;max-width:560px}
.beer-card h2{font-size:16px;margin:0 0 6px}
.beer-muted{color:var(--ink3);font-size:12px}
.beer-err{background:var(--bad-soft);color:var(--bad);border-radius:8px;padding:6px 10px;margin:8px 0;font-size:12px}
.beer-chat{flex:none;display:flex;flex-direction:column;border-left:1px solid var(--line);background:var(--paper);min-height:0}
.beer-chat-hd{display:flex;align-items:center;gap:6px;padding:6px 10px;border-bottom:1px solid var(--line);flex:none}
.beer-chat-mount{flex:1;min-height:0;display:flex;flex-direction:column}
.beer-chat-empty{padding:16px 14px;display:flex;flex-direction:column;gap:8px;align-items:flex-start}
.beer-chat-new{margin-left:auto}
.beer-chat-long{flex:none;margin:8px 10px 0;padding:5px 10px;border-radius:8px;background:var(--accent-soft);color:var(--accent-ink);font-size:12px}
.beer-chat.mini .beer-chat-hd{flex-direction:column;border:none;padding-top:10px}
.beer-chat.mini .beer-v{writing-mode:vertical-rl;color:var(--ink2);font-size:12px;letter-spacing:.2em}
.beer-lib{display:flex;gap:12px;min-height:100%;min-width:0}
.beer-lib.narrow{flex-direction:column;overflow:auto}
.beer-pane{border:1px solid var(--line);border-radius:12px;background:#fff;min-width:0}
.beer-list{width:260px;flex:none;padding:10px 8px;overflow:auto}
.beer-lib.narrow .beer-list{width:auto;max-height:40vh}
.beer-crumbs{display:flex;flex-wrap:wrap;gap:2px;align-items:center;padding:0 6px 6px;font-size:12px;color:var(--ink2);overflow-wrap:anywhere}
.beer-crumbs button{border:none;background:none;padding:0 2px;font:inherit;color:var(--accent-ink);cursor:pointer}
.beer-item{display:flex;gap:6px;align-items:center;width:100%;text-align:left;border:none;background:none;border-radius:7px;padding:4px 8px;font:inherit;color:var(--ink);cursor:pointer;min-width:0}
.beer-item span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.beer-item:hover{background:var(--bg)}
.beer-item.on{background:var(--accent-soft);color:var(--accent-ink);font-weight:600}
.beer-item:disabled{color:var(--ink3);cursor:default;background:none}
.beer-row{display:flex;gap:2px;align-items:center;min-width:0}
.beer-row .beer-item{flex:1;min-width:0}
.beer-del{padding:2px 6px;color:var(--bad);opacity:.6;flex:none}
.beer-row:hover .beer-del,.beer-del:focus{opacity:1}
.beer-trash{display:flex;flex-direction:column;gap:8px;max-width:760px}
.beer-trash-hd{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:2px}
.beer-trash-hd .beer-muted{flex:1 1 220px;min-width:0}
.beer-trash-item{display:flex;gap:10px;align-items:center;border:1px solid var(--line);border-radius:10px;background:#fff;padding:8px 12px;min-width:0}
.beer-trash-main{flex:1;min-width:0;display:flex;flex-direction:column}
.beer-trash-main b{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600}
.beer-doc{flex:1;display:flex;flex-direction:column;min-width:0}
.beer-doc-hd{display:flex;gap:6px;align-items:center;flex-wrap:wrap;padding:8px 12px;border-bottom:1px solid var(--line)}
.beer-doc-hd b{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;flex:1 1 120px}
.beer-chip{font-size:11px;border-radius:999px;padding:1px 8px;background:var(--bg);color:var(--ink2);white-space:nowrap}
.beer-chip.bad{background:var(--bad-soft);color:var(--bad)}
.beer-prev{padding:12px 16px;overflow:auto;overflow-wrap:anywhere}
.beer-prev h1,.beer-prev h2,.beer-prev h3,.beer-prev h4{margin:.8em 0 .4em;line-height:1.35}
.beer-prev h1{font-size:20px}.beer-prev h2{font-size:17px}.beer-prev h3{font-size:15px}
.beer-prev p{margin:.5em 0}
.beer-prev pre{background:var(--bg);border-radius:8px;padding:8px 10px;overflow:auto;font-size:12px}
.beer-prev code{background:var(--bg);border-radius:4px;padding:0 3px;font-size:12px}
.beer-prev blockquote{margin:.5em 0;padding-left:10px;border-left:3px solid var(--line);color:var(--ink2)}
.beer-props{background:var(--bg);border-radius:8px;padding:6px 10px;font-size:12px;color:var(--ink2);white-space:pre-wrap;margin-bottom:8px}
.beer-wiki{color:var(--accent-ink)}
.beer-prev img{max-width:100%;height:auto;border-radius:6px;vertical-align:middle}
.beer-prev p>img:only-child{display:block;margin:.4em 0}
.beer-img-missing{display:inline-block;color:var(--muted);background:var(--bg);border-radius:4px;padding:0 6px;font-size:12px}
.beer-live{display:flex;flex-direction:column;padding:0;overflow:hidden}
.beer-live>.cm-editor{flex:1;min-height:0}
.beer-editor{flex:1;min-height:320px;border:none;outline:none;resize:none;padding:12px 16px;font:13px/1.7 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--ink);background:#fff;border-radius:0 0 12px 12px}
.beer-conflict{margin:10px 12px 0;border:1px solid var(--bad);background:var(--bad-soft);border-radius:10px;padding:10px 12px;font-size:13px}
.beer-conflict b{color:var(--bad)}
.beer-quota{display:inline-flex;gap:4px;align-items:center;border:1px solid var(--line);border-radius:999px;background:#fff;padding:2px 10px;font:inherit;font-size:12px;color:var(--ink2);white-space:nowrap;cursor:pointer}
.beer-quota b{color:var(--ink);font-weight:600}
.beer-quota .full{color:var(--bad)}
.beer-quota.bad{background:var(--bad-soft);border-color:var(--bad-soft);color:var(--bad)}
.beer-machines{display:inline-flex;gap:10px;align-items:center;border:1px solid var(--line);border-radius:999px;background:#fff;padding:2px 10px;font:inherit;font-size:12px;color:var(--ink2);white-space:nowrap;cursor:pointer}
.beer-machine{display:inline-flex;gap:4px;align-items:center}
.beer-machine i{width:7px;height:7px;border-radius:50%;background:var(--ink3);display:inline-block}
.beer-machine.on i{background:#4f9d69}
.beer-machines.bad{background:var(--bad-soft);border-color:var(--bad-soft);color:var(--bad)}
.beer-rec{display:flex;flex-direction:column;gap:10px;min-height:100%;min-width:0}
.beer-drop{border:2px dashed var(--line);border-radius:12px;background:#fff;padding:18px 16px;text-align:center;color:var(--ink2);cursor:pointer;line-height:1.8}
.beer-drop.on{border-color:var(--accent);background:var(--accent-soft);color:var(--accent-ink)}
.beer-rec-list{display:flex;flex-direction:column;gap:8px;min-width:0}
.beer-rec-item{border:1px solid var(--line);border-radius:12px;background:#fff;padding:10px 12px;display:flex;flex-direction:column;gap:8px;min-width:0}
.beer-rec-item.on{border-color:var(--accent);background:var(--accent-soft)}
.beer-player{border:1px solid var(--line);border-radius:12px;background:#fff;padding:10px 12px;display:flex;flex-direction:column;gap:8px;min-width:0}
.beer-player audio{width:100%;min-width:0}
.beer-playchip{border:1px solid var(--line);background:#fff;cursor:pointer;font:inherit;font-size:11px;color:var(--ink2);border-radius:999px;padding:1px 8px;white-space:nowrap}
.beer-playchip:hover{border-color:var(--accent);color:var(--accent-ink);background:var(--accent-soft)}
.beer-rec-hd{display:flex;gap:8px;align-items:center;flex-wrap:wrap;min-width:0}
.beer-rec-hd b{flex:1 1 160px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.beer-steps{display:flex;gap:4px;flex-wrap:wrap}
.beer-step{font-size:11px;border-radius:999px;padding:1px 8px;background:var(--bg);color:var(--ink3)}
.beer-step.done{background:#e7f2ea;color:#3d7a52}
.beer-step.running{background:var(--accent-soft);color:var(--accent-ink)}
.beer-step.failed{background:var(--bad-soft);color:var(--bad)}
.beer-bar{height:5px;border-radius:999px;background:var(--bg);overflow:hidden}
.beer-bar>i{display:block;height:100%;background:var(--accent);transition:width .2s}
.beer-summary{background:var(--bg);border-radius:8px;padding:6px 10px;font-size:13px;overflow-wrap:anywhere}
.beer-summary .beer-prev{padding:0;overflow:visible}
.beer-actions{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.beer-art-new{display:flex;gap:6px;padding:0 0 8px}
.beer-art-new form{display:flex;gap:6px;width:100%;min-width:0}
.beer-art-new input{flex:1;min-width:0;border:1px solid var(--line);border-radius:7px;background:#fff;padding:4px 8px;font:inherit;font-size:13px;color:var(--ink)}
.beer-filters{display:flex;flex-wrap:wrap;gap:4px;padding:0 0 8px}
.beer-filter{border:1px solid var(--line);background:#fff;border-radius:999px;padding:1px 9px;font:inherit;font-size:12px;color:var(--ink2);cursor:pointer;white-space:nowrap}
.beer-filter.on{background:var(--ink);border-color:var(--ink);color:#fff}
.beer-art{display:flex;flex-direction:column;gap:2px;width:100%;text-align:left;border:1px solid transparent;border-bottom-color:var(--line);background:none;padding:7px 8px;font:inherit;color:var(--ink);cursor:pointer;border-radius:8px;min-width:0}
.beer-art:hover{background:var(--bg)}
.beer-art.on{background:var(--accent-soft);border-color:var(--accent)}
.beer-art b{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.beer-art .row{display:flex;gap:6px;align-items:center;min-width:0}
.beer-art-title{display:flex;gap:6px;align-items:center;flex-wrap:wrap;padding:8px 12px;border-bottom:1px solid var(--line)}
.beer-art-title b{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;flex:1 1 160px}
.beer-art-title input{flex:1 1 180px;min-width:0;border:1px solid var(--line);border-radius:7px;background:#fff;padding:3px 8px;font:inherit;font-size:13px;color:var(--ink)}
.beer-art-actions{display:flex;gap:6px;flex-wrap:wrap;align-items:center;padding:7px 12px;border-bottom:1px solid var(--line)}
.beer-art-actions .beer-muted{flex:1 1 180px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.beer-assist{display:flex;gap:6px;flex-wrap:wrap;align-items:center;padding:7px 12px;border-bottom:1px solid var(--line);background:var(--bg)}
.beer-assist textarea{width:100%;min-height:70px;border:1px solid var(--line);border-radius:8px;padding:6px 8px;font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--ink);background:#fff;resize:vertical}
.beer-versions{border-bottom:1px solid var(--line);background:#fff;padding:7px 12px;display:flex;flex-direction:column;gap:6px}
.beer-version-hd{display:flex;gap:6px;align-items:center;flex-wrap:wrap;min-width:0}
.beer-version-hd b{flex:1 1 120px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.beer-version{display:flex;gap:6px;align-items:center;flex-wrap:wrap;border:1px solid var(--line);border-radius:8px;padding:4px 8px}
.beer-version .name{font-weight:600}
.beer-chip.warn{background:var(--accent-soft);color:var(--accent-ink)}
.beer-version-diff{border:1px solid var(--line);border-radius:8px;background:var(--bg);padding:5px 8px;font:12px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;overflow:auto;max-height:180px}
.beer-version-diff .add{color:var(--ink)}
.beer-version-diff .del{color:var(--bad);text-decoration:line-through}
.beer-version-prev{border:1px solid var(--line);border-radius:8px;max-height:260px;overflow:auto}
.beer-version-prev .beer-prev{padding:8px 12px}
.beer-rules{display:flex;flex-direction:column;gap:10px;max-width:860px;min-width:0}
.beer-rule-head{display:flex;gap:10px;align-items:flex-start;flex-wrap:wrap;border:1px solid var(--line);border-radius:12px;background:#fff;padding:12px 14px}
.beer-rule-head>div{flex:1 1 260px;min-width:0}
.beer-switch{display:inline-flex;gap:6px;align-items:center;font-size:12px;color:var(--ink2);cursor:pointer;white-space:nowrap}
.beer-switch input{accent-color:var(--accent);margin:0}
.beer-rule-group{border:1px solid var(--line);border-radius:12px;background:#fff;padding:10px 12px;display:flex;flex-direction:column;gap:6px}
.beer-rule-group>b{font-size:13px}
.beer-rule-item{display:flex;gap:8px;align-items:center;flex-wrap:wrap;border:1px solid var(--line);border-radius:8px;padding:5px 9px;min-width:0}
.beer-rule-text{flex:1 1 220px;min-width:0;overflow-wrap:anywhere}
.beer-rule-warns{border:1px solid var(--accent);background:var(--accent-soft);border-radius:8px;padding:6px 10px;font-size:12px;color:var(--accent-ink);display:flex;flex-direction:column;gap:3px}
.beer-mat{display:flex;flex-direction:column;gap:10px;min-height:100%}
.beer-mat-filters{display:flex;flex-direction:column;gap:7px;border:1px solid var(--line);border-radius:12px;background:#fff;padding:10px 12px}
.beer-rowo{display:flex;gap:6px;align-items:center;flex-wrap:wrap;min-width:0}
.beer-flabel{font-size:12px;color:var(--ink3);flex:none}
.beer-pill{border:1px solid var(--line);border-radius:999px;background:#fff;padding:2px 11px;font:inherit;font-size:12px;color:var(--ink2);cursor:pointer;white-space:nowrap}
.beer-pill.on{background:var(--ink);border-color:var(--ink);color:#fff}
.beer-mat-select{border:1px solid var(--line);border-radius:7px;background:#fff;padding:3px 8px;font:inherit;font-size:12px;color:var(--ink);max-width:180px}
.beer-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:10px}
.beer-matcard{display:flex;flex-direction:column;gap:5px;text-align:left;border:1px solid var(--line);border-radius:12px;background:#fff;padding:10px 12px;font:inherit;color:var(--ink);cursor:pointer;min-width:0}
.beer-matcard:hover{border-color:var(--accent);box-shadow:0 1px 6px rgba(0,0,0,.04)}
.beer-matcard-hd{display:flex;gap:6px;align-items:flex-start;min-width:0}
.beer-matcard-hd b{font-size:14px;line-height:1.4;flex:1;min-width:0;overflow-wrap:anywhere}
.beer-tags{display:flex;flex-wrap:wrap;gap:4px}
.beer-sum{font-size:12px;color:var(--ink2);overflow:hidden;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow-wrap:anywhere}
.beer-tagbar{border:1px solid var(--line);border-radius:12px;background:#fff;padding:10px 12px;display:flex;flex-direction:column;gap:8px}
.beer-tagchip{display:inline-flex;gap:2px;align-items:center;font-size:12px;border-radius:999px;background:var(--bg);color:var(--ink2);padding:1px 4px 1px 9px}
.beer-tagchip button{border:none;background:none;color:var(--ink3);cursor:pointer;font:inherit;padding:0 4px;line-height:1.2}
.beer-tagchip button:hover{color:var(--bad)}
.beer-taginput{border:1px solid var(--line);border-radius:7px;background:#fff;padding:3px 8px;font:inherit;font-size:13px;min-width:120px}
.beer-mat-detail{display:flex;flex-direction:column;gap:10px;min-height:100%}
.beer-mat-bar{display:flex;gap:8px;align-items:center;min-width:0}
.beer-mat-bar b{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.beer-matcard.on{border-color:var(--accent);background:var(--accent-soft)}
.beer-matcheck{flex:none;width:16px;height:16px;border:1px solid var(--line);border-radius:4px;display:inline-flex;align-items:center;justify-content:center;font-size:11px;background:#fff;color:var(--accent-ink)}
.beer-matcard.on .beer-matcheck{border-color:var(--accent);background:var(--accent);color:#fff}
.beer-matselectbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;border-radius:10px;background:var(--ink);color:#fff;padding:7px 10px}
.beer-matselectbar .beer-mat-select{max-width:260px}
.beer-matselectbar .beer-muted{color:#d8d0c5}
.beer-topics{display:flex;flex-direction:column;gap:12px;min-height:100%;min-width:0}
.beer-topic-hd{display:flex;gap:8px;align-items:center;flex-wrap:wrap;border:1px solid var(--line);border-radius:12px;background:#fff;padding:10px 12px}
.beer-topic-hd .beer-muted{flex:1 1 200px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.beer-topic-sec{font-size:12px;color:var(--ink3);padding:0 2px}
.beer-angle{border:1px solid var(--line);border-radius:12px;background:#fff;padding:10px 12px;display:flex;flex-direction:column;gap:6px;min-width:0}
.beer-angle h3{font-size:14px;margin:0;overflow-wrap:anywhere}
.beer-angle .why{font-size:13px;color:var(--ink2);overflow-wrap:anywhere}
.beer-angle .refs{display:flex;flex-wrap:wrap;gap:4px}
.beer-angle .acts{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.beer-topic-list{display:flex;flex-direction:column;gap:2px;border:1px solid var(--line);border-radius:12px;background:#fff;padding:6px}
.beer-topic-brief{border:1px solid var(--line);border-radius:12px;background:#fff;padding:0 12px 8px;max-height:420px;overflow:auto}
.beer-topic-brief summary{cursor:pointer;padding:9px 0;font-weight:600}
.beer-overlay{position:absolute;inset:0;z-index:8;display:flex;justify-content:center;align-items:flex-start;padding:56px 16px 16px;background:rgba(40,30,20,.22)}
.beer-modal{width:min(680px,100%);max-height:100%;display:flex;flex-direction:column;background:#fff;border:1px solid var(--line);border-radius:12px;box-shadow:0 18px 50px rgba(0,0,0,.18);overflow:hidden}
.beer-searchhd{display:flex;gap:8px;align-items:center;padding:9px 12px;border-bottom:1px solid var(--line);flex:none;flex-wrap:wrap}
.beer-searchhd input{flex:1 1 220px;min-width:0;border:none;outline:none;font:inherit;font-size:15px;color:var(--ink);background:transparent}
.beer-searchhd .beer-muted{white-space:nowrap}
.beer-sr{flex:1;overflow:auto;padding:4px 6px 8px;min-height:80px}
.beer-sr-group{font-size:11px;color:var(--ink3);letter-spacing:.04em;margin:8px 10px 2px}
.beer-hit{display:block;width:100%;text-align:left;border:none;background:none;border-radius:8px;padding:6px 10px;font:inherit;color:var(--ink);cursor:pointer;min-width:0}
.beer-hit:hover{background:var(--bg)}
.beer-hit.on{background:var(--accent-soft)}
.beer-hit-t{display:flex;gap:6px;align-items:center;min-width:0}
.beer-hit-t b{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.beer-hit-t .beer-muted{margin-left:auto;white-space:nowrap;flex:none;font-size:11px}
.beer-hit-s{font-size:12px;color:var(--ink2);margin-top:2px;overflow-wrap:anywhere}
.beer-hit-s mark{background:#fde9c8;border-radius:2px;color:inherit;padding:0 1px}
.beer-hit-act{display:flex;gap:6px;margin-top:4px;align-items:center;flex-wrap:wrap}
.beer-hit-act button{border:1px solid var(--line);background:#fff;border-radius:6px;padding:1px 7px;font:inherit;font-size:11px;color:var(--ink2);cursor:pointer}
.beer-hit-act button:hover{border-color:var(--accent);color:var(--accent-ink)}
.beer-searchft{display:flex;gap:10px;align-items:center;padding:7px 12px;border-top:1px solid var(--line);background:var(--paper);font-size:11px;color:var(--ink3);flex-wrap:wrap;flex:none}
.beer-kbd{border:1px solid var(--line);border-bottom-width:2px;border-radius:4px;background:#fff;padding:0 4px;font-size:10px;color:var(--ink2)}
.beer-gear{border:1px solid var(--line);background:#fff;border-radius:999px;width:26px;height:24px;font:inherit;font-size:14px;line-height:1;color:var(--ink2);cursor:pointer;flex:none}
.beer-gear:hover,.beer-gear[aria-expanded=true]{border-color:var(--accent);color:var(--accent-ink)}
.beer-set{flex:1;overflow:auto;padding:4px 14px 14px;display:flex;flex-direction:column;gap:10px;min-height:0}
.beer-set h3{font-size:12px;color:var(--ink3);font-weight:600;letter-spacing:.04em;margin:8px 0 0}
.beer-secret{border:1px solid var(--line);border-radius:10px;padding:8px 10px;display:flex;flex-direction:column;gap:6px;min-width:0}
.beer-secret-hd{display:flex;gap:8px;align-items:center;flex-wrap:wrap;min-width:0}
.beer-secret-hd b{font-size:13px}
.beer-secret-hd code{font-size:11px;color:var(--ink3)}
.beer-chip.ok{background:#e3f1e7;color:#2f7a48}
.beer-secret form{display:flex;gap:6px;align-items:center;min-width:0}
.beer-secret input{flex:1;min-width:0;border:1px solid var(--line);border-radius:7px;padding:4px 8px;font:inherit;font-size:12px;background:#fff;color:var(--ink)}
.beer-secret input:focus{outline:none;border-color:var(--accent)}
.beer-secret .beer-err{margin:0}
.beer-cfg{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:4px 12px;font-size:12px;border:1px solid var(--line);border-radius:10px;padding:8px 10px;background:var(--paper)}
.beer-cfg dt{color:var(--ink2)}
.beer-cfg dd{margin:0;overflow-wrap:anywhere;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.beer-linkbtn{border:none;background:none;color:var(--accent-ink);font:inherit;font-size:11px;cursor:pointer;padding:0;margin-left:auto}
.beer-libwrap{display:flex;flex-direction:column;gap:8px;height:100%;min-height:0;min-width:0}
.beer-libwrap>.beer-lib{flex:1;min-height:0}
.beer-libsearch{display:flex;gap:6px;align-items:center;flex:none}
.beer-libsearch input{flex:0 1 300px;min-width:110px;border:1px solid var(--line);border-radius:8px;background:#fff;padding:3px 10px;font:inherit;font-size:12px;color:var(--ink)}
.beer-libsearch input:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 2px var(--accent-soft)}
.beer-toast{position:relative;z-index:9;background:var(--accent-soft);color:var(--accent-ink);border-radius:8px;padding:5px 10px;margin:6px 0 0;font-size:12px}
.beer-pub{display:flex;gap:12px;min-height:100%;min-width:0}
.beer-pub.narrow{flex-direction:column;overflow:auto}
.beer-pub-doc{flex:1;min-width:0;display:flex;flex-direction:column}
.beer-pub-hd{display:flex;gap:6px;align-items:center;flex-wrap:wrap;padding:8px 12px;border-bottom:1px solid var(--line)}
.beer-pub-hd b{flex:1 1 200px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.beer-pub-acts{display:flex;gap:6px;align-items:center;flex-wrap:wrap;padding:8px 12px;border-bottom:1px solid var(--line);background:var(--bg)}
.beer-pub-acts .beer-muted{flex:1 1 220px;min-width:0}
.beer-pub-body{padding:10px 12px;display:flex;flex-direction:column;gap:10px;overflow:auto}
.beer-pub-block{border:1px solid var(--line);border-radius:10px;background:#fff;min-width:0}
.beer-pub-block-hd{display:flex;gap:6px;align-items:center;flex-wrap:wrap;padding:5px 10px;border-bottom:1px solid var(--line);font-size:12px;color:var(--ink2)}
.beer-pub-block-hd b{color:var(--ink);font-size:13px}
.beer-pub-main{max-height:280px;overflow:auto}
.beer-pub-diff{font:12px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--bg);border-radius:0 0 10px 10px;padding:6px 10px;overflow:auto;max-height:300px;white-space:pre-wrap;overflow-wrap:anywhere}
.beer-pub-diff .same{color:var(--ink2)}
.beer-pub-diff .added{color:var(--accent-ink);background:var(--accent-soft)}
.beer-pub-diff .removed{color:var(--bad);background:var(--bad-soft)}
.beer-pub-empty{padding:24px 14px;color:var(--ink3);font-size:12px}
.beer-pub.narrow .beer-list{width:auto;max-height:40vh}
.beer-pub-list .beer-item span:first-child{flex:1 1 auto}
.beer-pub-list .beer-item .beer-chip{flex:none}
.beer-pub-toggle{display:flex;gap:4px;align-items:center;font-size:12px;color:var(--ink2);cursor:pointer;white-space:nowrap}
.beer-pub-pack-body{padding:8px 10px;display:flex;flex-direction:column;gap:6px;font-size:12px;min-width:0}
.beer-pub-path{font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--bg);border-radius:6px;padding:4px 8px;overflow-wrap:anywhere;user-select:all}
.beer-pub-img{font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--ink2);overflow-wrap:anywhere}
.beer-pub-record{font:12px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--bg);border-radius:0 0 10px 10px;padding:6px 10px;white-space:pre-wrap;overflow-wrap:anywhere;max-height:160px;overflow:auto;color:var(--ink2)}
.beer-pub-url{flex:1 1 240px;min-width:140px;border:1px solid var(--line);border-radius:7px;background:#fff;padding:3px 8px;font:inherit;font-size:12px;color:var(--ink)}
.beer-pub-url:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 2px var(--accent-soft)}
.beer-pub-select{border:1px solid var(--line);border-radius:7px;background:#fff;padding:3px 6px;font:inherit;font-size:12px;color:var(--ink)}
.beer-pub-link{color:var(--accent-ink);overflow-wrap:anywhere}
.beer-home{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:10px;align-content:start;min-height:100%;min-width:0}
.beer-home.narrow{grid-template-columns:1fr}
.beer-home-tile{border:1px solid var(--line);border-radius:12px;background:#fff;padding:12px 14px;display:flex;flex-direction:column;gap:8px;min-width:0}
.beer-home-tile.wide{grid-column:span 2}
.beer-home.narrow .beer-home-tile.wide{grid-column:span 1}
.beer-home-tile.full{grid-column:1/-1}
.beer-home-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;min-width:0}
.beer-home-row>b{font-size:14px}
.beer-home-task{display:flex;gap:8px;align-items:center;border:1px solid var(--line);border-radius:10px;background:var(--paper);padding:6px 9px;text-align:left;font:inherit;font-size:13px;color:var(--ink);cursor:pointer;min-width:0}
.beer-home-task:hover{border-color:var(--accent);background:var(--accent-soft)}
.beer-home-task b{flex:1 1 120px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600}
.beer-home-task .go{flex:none;color:var(--accent-ink);font-size:12px}
.beer-home-stats{display:flex;gap:18px;flex-wrap:wrap;margin-top:2px}
.beer-home-stat b{display:block;font-size:24px;line-height:1.2}
.beer-home-stat span{font-size:11px;color:var(--ink3)}
.beer-home-rec{display:flex;flex-direction:column;gap:3px;min-width:0}
.beer-home-rec b{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.beer-home-brief{border:1px solid var(--line);border-radius:10px;background:var(--paper);padding:0 10px;max-height:360px;overflow:auto}
.beer-home-brief .beer-prev{padding:6px 0 8px}
`

    async function api(method, path, body) {
      const res = await fetch(API + path, {
        method,
        credentials: 'same-origin',
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        const err = new Error(data?.error?.message || `请求失败（${res.status}）`)
        err.status = res.status
        err.code = data?.error?.code
        err.body = data
        throw err
      }
      return data
    }

    async function pickDirectory() {
      const preload = globalThis.__DSH_DIRECTORY_PICKER__
      let picked
      if (preload && typeof preload.pick === 'function') picked = await preload.pick()
      else {
        let ws
        try { ws = hostCtx?.get?.('uiWorkspace') } catch {}
        if (!ws || typeof ws.pickDirectory !== 'function') throw new Error('宿主没有提供目录选择器')
        picked = await ws.pickDirectory()
      }
      if (!picked) return null
      if (typeof picked === 'string') return picked
      if (picked.canceled || picked.cancelled) return null
      return picked.path || (Array.isArray(picked.filePaths) ? picked.filePaths[0] : null) || null
    }

    /**
     * 宿主按「调用方插件」认工作台：ensureSession / ownsSession / isActive 只能通过本插件 ctx 上的
     * desktopWorkbenches 调。组件 props 里的 service 是宿主自己的实例，用它调会报
     * 「Workbench registration requires a client package entry name」。拿不到时才退回 props 的。
     */
    function workbenchService(fallback) {
      try { return hostCtx?.desktopWorkbenches ?? fallback } catch { return fallback }
    }

    function currentSessionId(service) {
      try {
        const cur = service?.currentSession?.()
        return typeof cur === 'string' ? cur : cur?.id ?? cur?.sessionId ?? null
      } catch { return null }
    }

    // ---- 搜索结果的共用小函数（标签、时间、把内容放进对话草稿 / 剪贴板） ----

    const IS_MAC = /Mac|iPhone|iPad/.test(globalThis.navigator?.platform ?? '')
    const SEARCH_KEY = IS_MAC ? '⌘K' : 'Ctrl+K'
    const KIND_LABELS = { article: '文章', material: '素材', transcript: '文字稿', brief: '选题简报', rule: '规则', note: '笔记' }
    const MATCHED_LABELS = { title: '命中标题', body: '命中正文', tags: '命中标签', status: '命中状态', type: '命中类型' }

    /** 一条搜索结果的引用文字：路径 + 文字稿时间点 + 命中片段。 */
    function hitReference(hit) {
      const lines = [`参考资料：${hit.path}`]
      if (hit.playAt != null) lines.push(`（文字稿约 ${formatClock(hit.playAt)} 处）`)
      if (hit.snippet) lines.push('> ' + hit.snippet)
      return lines.join('\n')
    }

    function formatClock(seconds) {
      const s = Math.max(0, Math.floor(seconds))
      const h = Math.floor(s / 3600)
      const m = Math.floor((s % 3600) / 60)
      const sec = String(s % 60).padStart(2, '0')
      return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`
    }

    /** 复制到剪贴板；宿主不允许剪贴板 API 时退回 textarea + execCommand。 */
    async function copyText(text) {
      try {
        if (globalThis.navigator?.clipboard?.writeText) {
          await navigator.clipboard.writeText(text)
          return true
        }
      } catch {}
      try {
        const area = document.createElement('textarea')
        area.value = text
        area.style.position = 'fixed'
        area.style.opacity = '0'
        document.body.appendChild(area)
        area.select()
        const ok = document.execCommand('copy')
        area.remove()
        return ok
      } catch { return false }
    }

    /** 宿主导出的对话输入框；没有可用会话或宿主没开放时返回 null。 */
    function conversationInputOf(service, sessionId) {
      try {
        const sessions = hostCtx?.sessions ?? (typeof hostCtx?.get === 'function' ? hostCtx.get('sessions') : null)
        const id = sessionId || currentSessionId(service)
        if (!sessions || !id || typeof sessions.scope !== 'function') return null
        const scoped = sessions.scope(id)
        const conversation = scoped?.get?.('conversation')
        const input = conversation?.input?.for?.(scoped)
        return typeof input?.setDraft === 'function' ? input : null
      } catch { return null }
    }

    /** 把一段文字接在对话草稿后面（不自动发送）。 */
    function appendToDraft(input, text) {
      const draft = input.state?.getSnapshot?.()?.draft ?? ''
      input.setDraft(draft.trim() ? `${draft}\n\n${text}` : text)
    }

    /** 当前显示的会话编号，以及它是否属于本工作台；没有本工作台的会话时 id 为 null。 */
    function useOwnedSession(service) {
      const read = () => {
        const id = currentSessionId(service)
        try { return id && service?.ownsSession?.(id) ? id : null } catch { return null }
      }
      const [ownedId, setOwnedId] = useState(read)
      useEffect(() => {
        setOwnedId(read())
        const off = service?.subscribe?.(() => setOwnedId(read()))
        return typeof off === 'function' ? off : undefined
      }, [service])
      return ownedId
    }

    // 当前会话超过这个 token 数时，对话栏提示可以点「新对话」（11-08 定，issue #28）。
    const LONG_CHAT_TOKENS = 150_000

    /**
     * 宿主给每个会话算的上下文占用（对话框下方圆环用的同一份 contextPressure 数据），
     * 从 sessions.list 快照的 projectionsBySession 里读。拿不到时返回 null，不报错。
     */
    function readContextTokens(sessionId) {
      try {
        const sessions = hostCtx?.sessions ?? (typeof hostCtx?.get === 'function' ? hostCtx.get('sessions') : null)
        const pressure = sessions?.list?.getSnapshot?.()?.projectionsBySession?.[sessionId]?.values?.contextPressure
        const tokens = pressure?.projectedTokens ?? pressure?.pressureTokens
        return Number.isFinite(tokens) ? tokens : null
      } catch { return null }
    }

    function useContextTokens(sessionId) {
      const [tokens, setTokens] = useState(() => sessionId ? readContextTokens(sessionId) : null)
      useEffect(() => {
        const read = () => setTokens(sessionId ? readContextTokens(sessionId) : null)
        read()
        if (!sessionId) return undefined
        let off
        try {
          const sessions = hostCtx?.sessions ?? (typeof hostCtx?.get === 'function' ? hostCtx.get('sessions') : null)
          off = sessions?.list?.subscribe?.(read)
        } catch {}
        return typeof off === 'function' ? off : undefined
      }, [sessionId])
      return tokens
    }

    function useContainerWidth(ref) {
      const [width, setWidth] = useState(1200)
      useEffect(() => {
        const el = ref.current
        if (!el || typeof ResizeObserver !== 'function') return
        const ro = new ResizeObserver(entries => setWidth(entries[0].contentRect.width))
        ro.observe(el)
        return () => ro.disconnect()
      }, [])
      return width
    }

    // ---- 库访问：分页绑定文件夹的列表 + 预览 / 编辑 / 保存（冲突时只提示，不覆盖） ----

    const fmtTime = iso => {
      try { return new Date(iso).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) } catch { return iso }
    }

    const fmtSize = n => {
      if (!Number.isFinite(n) || n < 0) return '大小未知'
      if (n < 1024) return `${n} B`
      if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
      return `${(n / 1024 / 1024).toFixed(1)} MB`
    }

    const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i

    /** 图片地址：http(s) 原样用；库里的图片走 /library/asset，按笔记所在文件夹解析。 */
    function imageSrc(target, base) {
      const src = String(target).trim()
      if (/^(https?:|data:image\/)/i.test(src)) return src
      const params = new URLSearchParams({ path: src })
      if (base) params.set('from', base)
      return `${API}/library/asset?${params}`
    }

    function PreviewImage({ src, alt, width }) {
      const [failed, setFailed] = useState(false)
      useEffect(() => setFailed(false), [src])
      if (failed) return h('span', { className: 'beer-img-missing', title: src }, `图片没找到：${alt || src}`)
      return h('img', { src, alt: alt || '', loading: 'lazy', style: width ? { width: `${width}px` } : undefined, onError: () => setFailed(true) })
    }

    /** ![[文件.png|300]] → { target, width }；不是图片返回 null（当普通双链显示）。 */
    function wikiEmbed(inner) {
      const [target, ...rest] = inner.split('|')
      const clean = target.split('#')[0].trim()
      if (!IMAGE_EXT.test(clean)) return null
      const size = /^(\d+)(x\d+)?$/.exec((rest[rest.length - 1] ?? '').trim())
      return { target: clean, width: size ? Number(size[1]) : undefined, alt: size ? '' : rest.join('|').trim() }
    }

    function renderInline(text, keyBase, base) {
      const out = []
      const re = /(`[^`]+`|!\[\[[^\]]+\]\]|!\[[^\]]*\]\([^)\s]+(?:\s+"[^"]*")?\)|\[[^\]]+\]\((?:https?:[^)\s]+)\)|\*\*[^*]+\*\*|\[\[[^\]]+\]\]|\*[^*\s][^*]*\*)/g
      let last = 0
      let m
      let i = 0
      while ((m = re.exec(text))) {
        if (m.index > last) out.push(text.slice(last, m.index))
        const tok = m[0]
        const key = `${keyBase}-${i++}`
        if (tok.startsWith('`')) out.push(h('code', { key }, tok.slice(1, -1)))
        else if (tok.startsWith('![[')) {
          const embed = wikiEmbed(tok.slice(3, -2))
          out.push(embed
            ? h(PreviewImage, { key, src: imageSrc(embed.target, base), alt: embed.alt || embed.target, width: embed.width })
            : h('span', { key, className: 'beer-wiki' }, tok.slice(3, -2).split('|').pop()))
        } else if (tok.startsWith('![')) {
          const m = /^!\[([^\]]*)\]\(([^)\s]+)/.exec(tok)
          const [alt, size] = m[1].split('|')
          const width = /^\d+$/.test((size ?? '').trim()) ? Number(size.trim()) : undefined
          out.push(h(PreviewImage, { key, src: imageSrc(m[2], base), alt, width }))
        } else if (tok.startsWith('[') && !tok.startsWith('[[')) {
          const m = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(tok)
          out.push(h('a', { key, href: m[2], target: '_blank', rel: 'noopener noreferrer' }, m[1]))
        } else if (tok.startsWith('**')) out.push(h('strong', { key }, tok.slice(2, -2)))
        else if (tok.startsWith('[[')) out.push(h('span', { key, className: 'beer-wiki' }, tok.slice(2, -2).split('|').pop()))
        else out.push(h('em', { key }, tok.slice(1, -1)))
        last = m.index + tok.length
      }
      if (last < text.length) out.push(text.slice(last))
      return out
    }

    // ---- 编辑器：CodeMirror 6 实时预览（服务端 /client/editor.js 按需加载），加载失败退回纯文字框 ----

    let editorModule = null
    function loadEditorModule() {
      if (!editorModule) {
        editorModule = import(/* webpackIgnore: true */ `${API}/client/editor.js`).catch(e => {
          editorModule = null
          throw e
        })
      }
      return editorModule
    }

    /** 编辑器里粘贴 / 拖入的图片：存到笔记旁边的 images/，返回写进正文的相对路径。 */
    async function uploadAttachment(file, notePath) {
      const params = new URLSearchParams({ from: notePath })
      if (file.name && !/^image\.\w+$/.test(file.name)) params.set('name', file.name) // 截图粘贴时浏览器给的 image.png 不要
      const res = await fetch(`${API}/library/attachment?${params}`, {
        method: 'POST', credentials: 'same-origin', headers: { 'content-type': file.type || 'application/octet-stream' }, body: file,
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data?.error?.message || `图片没有保存成功（${res.status}）`)
      return data.link
    }

    function LiveEditor({ value, onChange, onSave, onError, base, ariaLabel }) {
      const hostRef = useRef(null)
      const editorRef = useRef(null)
      const [failed, setFailed] = useState(false)
      const emitted = useRef(value) // 编辑器自己最后报出去的内容
      const callbacks = useRef({ onChange, onSave, onError })
      callbacks.current = { onChange, onSave, onError }

      useEffect(() => {
        let cancelled = false
        loadEditorModule().then(mod => {
          if (cancelled || !hostRef.current) return
          editorRef.current = mod.createLiveEditor({
            parent: hostRef.current,
            doc: value,
            ariaLabel,
            imageUrl: src => imageSrc(src, base),
            uploadImage: base ? file => uploadAttachment(file, base) : undefined,
            onError: msg => callbacks.current.onError?.(msg),
            onChange: text => { emitted.current = text; callbacks.current.onChange?.(text) },
            onSave: () => callbacks.current.onSave?.(),
          })
        }).catch(() => { if (!cancelled) setFailed(true) })
        return () => {
          cancelled = true
          editorRef.current?.destroy()
          editorRef.current = null
        }
      }, [base])

      // 外面换了内容（比如冲突后重新读）才同步进编辑器；自己打字引起的 value 变化不回写
      useEffect(() => {
        if (value === emitted.current) return
        emitted.current = value
        editorRef.current?.setValue(value)
      }, [value])

      if (failed) {
        return h('textarea', {
          className: 'beer-editor', value, spellCheck: false, 'aria-label': ariaLabel,
          onChange: e => onChange(e.target.value),
          onKeyDown: e => { if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); onSave?.() } },
        })
      }
      return h('div', { className: 'beer-editor beer-live', ref: hostRef })
    }

    const LIST_ITEM = /^\s*([-*+]|\d+[.)])\s+/

    // 只做常用的 Markdown 预览（开头属性、标题、段落、列表、引用、代码、粗体、[[链接]]），
    // 全部用 React 元素生成，不插入 HTML。
    function MarkdownPreview({ source, base }) {
      let lines = source.replace(/\r\n?/g, '\n').split('\n')
      const blocks = []
      if (lines[0] === '---') {
        const end = lines.indexOf('---', 1)
        if (end > 0) {
          blocks.push(h('div', { key: 'props', className: 'beer-props' }, lines.slice(1, end).join('\n')))
          lines = lines.slice(end + 1)
        }
      }
      let i = 0
      let k = 0
      while (i < lines.length) {
        const line = lines[i]
        const key = `b${k++}`
        if (/^```/.test(line)) {
          const body = []
          i++
          while (i < lines.length && !/^```/.test(lines[i])) body.push(lines[i++])
          i++
          blocks.push(h('pre', { key }, body.join('\n')))
          continue
        }
        const head = /^(#{1,6})\s+(.*)$/.exec(line)
        if (head) {
          blocks.push(h('h' + Math.min(head[1].length, 4), { key }, renderInline(head[2], key, base)))
          i++
          continue
        }
        if (LIST_ITEM.test(line)) {
          const ordered = /^\s*\d/.test(line)
          const items = []
          while (i < lines.length && LIST_ITEM.test(lines[i])) {
            items.push(h('li', { key: i }, renderInline(lines[i].replace(LIST_ITEM, ''), `${key}-${i}`, base)))
            i++
          }
          blocks.push(h(ordered ? 'ol' : 'ul', { key }, items))
          continue
        }
        if (/^>\s?/.test(line)) {
          const body = []
          while (i < lines.length && /^>\s?/.test(lines[i])) body.push(lines[i++].replace(/^>\s?/, ''))
          blocks.push(h('blockquote', { key }, renderInline(body.join(' '), key, base)))
          continue
        }
        if (!line.trim()) { i++; continue }
        const para = []
        while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|```|>)/.test(lines[i]) && !LIST_ITEM.test(lines[i])) para.push(lines[i++])
        blocks.push(h('p', { key }, renderInline(para.join(' '), key, base)))
      }
      return h('div', { className: 'beer-prev' }, blocks.length ? blocks : h('p', { className: 'beer-muted' }, '（空文件）'))
    }

    function LibraryView({ folder, tabId, tabTitle, narrow, onError, openRequest }) {
      const [dir, setDir] = useState(folder)
      const [listing, setListing] = useState(null)
      const [doc, setDoc] = useState(null) // { path, content, version, modifiedAt, openedAt }
      const [editing, setEditing] = useState(false)
      const [draft, setDraft] = useState('')
      const [conflict, setConflict] = useState(null) // { current: { version, modifiedAt } | null }
      const [saving, setSaving] = useState(false)
      const [localInput, setLocalInput] = useState('')
      const [localResults, setLocalResults] = useState(null)
      const [localBusy, setLocalBusy] = useState(false)
      const localToken = useRef(0)
      const handledOpen = useRef(null)

      const loadDir = useCallback(async path => {
        try {
          setListing(await api('GET', '/library/folder?path=' + encodeURIComponent(path)))
          setDir(path)
        } catch (e) { onError(e.message) }
      }, [onError])
      useEffect(() => { loadDir(folder) }, [folder, loadDir])

      const dirty = editing && doc && draft !== doc.content
      const leaveEditor = () => !dirty || window.confirm('还有没保存的改动，确定放弃吗？')

      // 每次打开都重新读，拿到最新内容和版本标记（同一个文件正在编辑时不打断）。
      const openFile = async path => {
        if (editing && doc?.path === path) return
        if (!leaveEditor()) return
        try {
          const d = await api('GET', '/library/file?path=' + encodeURIComponent(path))
          setDoc({ ...d, openedAt: new Date().toISOString() })
          setEditing(false)
          setConflict(null)
        } catch (e) {
          if (e.code === 'not_found') { setDoc(null); setEditing(false); setConflict(null); loadDir(dir) }
          onError(e.message)
        }
      }

      const startEdit = () => { setDraft(doc.content); setEditing(true); setConflict(null) }
      // 取消编辑后重新读一次文件，冲突时预览显示的是别处改过之后的内容。
      const cancelEdit = () => {
        if (!leaveEditor()) return
        setEditing(false)
        const path = doc.path
        setConflict(null)
        api('GET', '/library/file?path=' + encodeURIComponent(path))
          .then(d => setDoc({ ...d, openedAt: new Date().toISOString() }))
          .catch(e => {
            if (e.code === 'not_found') { setDoc(null); loadDir(dir) }
            onError(e.message)
          })
      }

      const save = async () => {
        if (!doc || saving) return
        setSaving(true)
        try {
          const r = await api('PUT', '/library/file', { path: doc.path, content: draft, baseVersion: doc.version })
          setDoc({ ...doc, content: draft, version: r.version, modifiedAt: r.modifiedAt, openedAt: new Date().toISOString() })
          setEditing(false)
          setConflict(null)
          onError('')
        } catch (e) {
          if (e.code === 'edit_conflict') setConflict({ current: e.body?.current ?? null })
          else onError(e.message)
        } finally { setSaving(false) }
      }

      // 从搜索结果打开：先把所在文件夹列出来（面包屑跟上），再读文件。
      const loadNoteAt = async (path, keepSearch = false) => {
        if (!leaveEditor()) return
        const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : folder
        try {
          const [nextListing, nextDoc] = await Promise.all([
            api('GET', '/library/folder?path=' + encodeURIComponent(parent)),
            api('GET', '/library/file?path=' + encodeURIComponent(path)),
          ])
          setListing(nextListing)
          setDir(parent)
          setDoc({ ...nextDoc, openedAt: new Date().toISOString() })
          setEditing(false)
          setConflict(null)
          if (!keepSearch) setLocalInput('')
        } catch (e) {
          if (e.code === 'not_found') { setDoc(null); setEditing(false); setConflict(null); loadDir(dir) }
          onError(e.message)
        }
      }

      useEffect(() => {
        if (!openRequest || handledOpen.current === openRequest.nonce) return
        handledOpen.current = openRequest.nonce
        loadNoteAt(openRequest.path)
      }, [openRequest])

      // 本页搜索：输入停下来 250 毫秒后查询，scope 限定当前分页；清空恢复原列表。
      const runLocalSearch = useCallback(async query => {
        const token = ++localToken.current
        setLocalBusy(true)
        try {
          const result = await api('GET', '/search?q=' + encodeURIComponent(query) + '&scope=' + encodeURIComponent(tabId))
          if (localToken.current === token) setLocalResults(result)
        } catch (e) {
          if (localToken.current === token) setLocalResults({ query, total: 0, groups: [], error: e.message })
        } finally {
          if (localToken.current === token) setLocalBusy(false)
        }
      }, [tabId])
      useEffect(() => {
        const query = localInput.trim()
        if (!query) { localToken.current++; setLocalResults(null); setLocalBusy(false); return }
        const timer = setTimeout(() => runLocalSearch(query), 250)
        return () => clearTimeout(timer)
      }, [localInput, runLocalSearch])

      // 删除 = 移到库里的 .trash，先确认；删完刷新列表，正在看的东西跟着清掉。
      const trashEntry = async entry => {
        const affectsDoc = doc && (doc.path === entry.path || doc.path.startsWith(entry.path + '/'))
        if (affectsDoc && !leaveEditor()) return
        if (!window.confirm(`把「${entry.name}」移到回收站？之后可以在回收站里恢复。`)) return
        try {
          await api('POST', '/library/trash', { path: entry.path })
          if (affectsDoc) {
            setDoc(null)
            setEditing(false)
            setConflict(null)
          }
          if (dir === entry.path || dir.startsWith(entry.path + '/')) loadDir(folder)
          else loadDir(dir)
          onError('')
        } catch (e) { onError(e.message) }
      }

      const crumbs = []
      if (dir !== folder && dir.startsWith(folder + '/')) {
        const rel = dir.slice(folder.length + 1).split('/')
        crumbs.push(h('button', { key: 'root', onClick: () => loadDir(folder) }, folder.split('/').pop()))
        rel.forEach((name, idx) => {
          const target = folder + '/' + rel.slice(0, idx + 1).join('/')
          crumbs.push(h('span', { key: 's' + idx }, '/'))
          crumbs.push(idx === rel.length - 1 ? h('b', { key: target }, name) : h('button', { key: target, onClick: () => loadDir(target) }, name))
        })
      } else if (dir === folder) crumbs.push(h('b', { key: 'root' }, folder))
      else crumbs.push(h('b', { key: 'outside', title: dir }, dir)) // 打开的是分页文件夹之外的文件，面包屑原样显示路径

      const entries = listing?.entries ?? []
      const hint = text => h('div', { className: 'beer-muted', style: { padding: '0 8px' } }, text)
      const localGroups = localResults?.groups ?? []
      const localCount = localGroups.reduce((sum, group) => sum + group.hits.length, 0)
      const list = h('div', { className: 'beer-pane beer-list' },
        localInput.trim()
          ? h('div', { className: 'beer-crumbs' },
            h('b', null, `本页搜索：${localInput.trim()}`),
            h('span', null, localBusy ? ' · 搜索中…' : localResults ? ` · ${localCount} 条` : ''))
          : h('div', { className: 'beer-crumbs', title: dir }, crumbs),
        localInput.trim()
          ? (localBusy && !localResults ? hint('搜索中…')
            : localResults?.error ? hint(localResults.error)
              : !localCount ? hint('本页没有命中。')
                : localGroups.map(group => [
                  h('div', { key: group.tabId + '-h', className: 'beer-sr-group' }, `${group.title} · ${group.hits.length}`),
                  ...group.hits.map(hit => h('button', {
                    key: hit.path,
                    className: 'beer-item' + (doc?.path === hit.path ? ' on' : ''),
                    title: hit.path,
                    onClick: () => loadNoteAt(hit.path, true),
                  }, h('span', null, hit.title))),
                ]))
          : !listing ? hint('加载中…')
            : !listing.exists ? hint(`库里还没有「${dir}」这个文件夹。`)
              : !entries.length ? hint('这个文件夹是空的。')
                : entries.map(e => {
                  const md = e.kind === 'file' && /\.md$/i.test(e.name)
                  return h('div', { key: e.path, className: 'beer-row' },
                    h('button', {
                      className: 'beer-item' + (doc?.path === e.path ? ' on' : ''),
                      disabled: e.kind === 'file' && !md,
                      title: e.kind === 'file' && !md ? `${e.name}（只能打开 Markdown 文件）` : e.name,
                      onClick: () => (e.kind === 'folder' ? loadDir(e.path) : openFile(e.path)),
                    }, h('span', null, e.kind === 'folder' ? '▸ ' + e.name : e.name)),
                    h('button', {
                      className: 'beer-btn ghost beer-del',
                      title: `把「${e.name}」移到回收站`,
                      'aria-label': `移到回收站：${e.name}`,
                      onClick: () => trashEntry(e),
                    }, '删除'))
                }))

      let pane
      if (!doc) pane = h('div', { className: 'beer-pane beer-doc' }, h('div', { className: 'beer-prev beer-muted' }, '从左边选一个 Markdown 文件预览。'))
      else {
        const name = doc.path.split('/').pop()
        pane = h('div', { className: 'beer-pane beer-doc' },
          h('div', { className: 'beer-doc-hd' },
            h('b', { title: doc.path }, name),
            editing && h('span', { className: 'beer-chip' }, dirty ? '编辑中 · 未保存' : '编辑中'),
            conflict && h('span', { className: 'beer-chip bad' }, '冲突'),
            editing
              ? [h('button', { key: 'c', className: 'beer-btn', onClick: cancelEdit }, '取消'),
                h('button', { key: 's', className: 'beer-btn pri', onClick: save, disabled: saving }, saving ? '保存中…' : '保存 ⌘S')]
              : h('button', { className: 'beer-btn pri', onClick: startEdit }, '编辑')),
          conflict && h('div', { className: 'beer-conflict', role: 'alert' },
            h('b', null, conflict.current ? '这个文件在别处被改过，没有保存' : '这个文件在别处被删掉了，没有保存'),
            h('div', null, conflict.current
              ? `你 ${fmtTime(doc.openedAt)} 打开它；之后它在 ${fmtTime(conflict.current.modifiedAt)} 被别处（例如 Obsidian）修改。`
              : `你 ${fmtTime(doc.openedAt)} 打开它之后，它被移走或删除了。`),
            h('div', { className: 'beer-muted' }, '原文件没有被覆盖，你的改动还在下面的编辑框里。冲突后怎么处理（合并、覆盖、放弃、另存副本）还没定，这一版只提示。')),
          editing
            ? h(LiveEditor, { value: draft, onChange: setDraft, onSave: save, onError, base: doc.path, ariaLabel: `编辑 ${name}` })
            : h(MarkdownPreview, { source: doc.content, base: doc.path }))
      }

      return h('div', { className: 'beer-libwrap' },
        h('div', { className: 'beer-libsearch' },
          h('input', {
            value: localInput,
            placeholder: '只搜本页…',
            'aria-label': `在「${tabTitle || '本页'}」里搜索`,
            onChange: e => setLocalInput(e.target.value),
            onKeyDown: e => { if (e.key === 'Escape' && localInput) { e.stopPropagation(); setLocalInput('') } },
          }),
          localInput && h('button', { className: 'beer-btn ghost', onClick: () => setLocalInput('') }, '清空')),
        h('div', { className: 'beer-lib' + (narrow ? ' narrow' : '') }, list, pane))
    }

    // 顶栏搜索浮层：⌘K 聚焦顶栏输入框，回车打开这里；结果按分页分组，命中处高亮。
    function Highlighted({ text, ranges }) {
      if (!ranges?.length) return text
      const parts = []
      let last = 0
      ranges.forEach((range, i) => {
        if (range.start > last) parts.push(text.slice(last, range.start))
        parts.push(h('mark', { key: i }, text.slice(range.start, range.end)))
        last = range.end
      })
      if (last < text.length) parts.push(text.slice(last))
      return h(React.Fragment, null, ...parts)
    }

    function SearchOverlay({ initialQuery, onClose, onOpen, onAttach, onAskAI, onPlayFrom }) {
      const [text, setText] = useState(initialQuery || '')
      const [includeTrash, setIncludeTrash] = useState(false)
      const [results, setResults] = useState(null) // { query, total, groups } | 带 error
      const [busy, setBusy] = useState(false)
      const [selected, setSelected] = useState(0)
      const inputRef = useRef(null)
      const searched = useRef(null)

      useEffect(() => { inputRef.current?.focus() }, [])

      const flat = []
      for (const group of results?.groups ?? []) for (const hit of group.hits) flat.push({ hit, groupTitle: group.title })

      const run = useCallback(async (query, withTrash) => {
        const q = query.trim()
        if (!q) { setResults({ query: '', total: 0, groups: [] }); searched.current = ''; return }
        setBusy(true)
        try {
          const page = await api('GET', '/search?q=' + encodeURIComponent(q) + (withTrash ? '&includeTrash=1' : ''))
          setResults(page)
          searched.current = page.query
          setSelected(0)
        } catch (e) {
          setResults({ query: q, total: 0, groups: [], error: e.message })
        } finally { setBusy(false) }
      }, [])

      // 顶栏里已经输入了词再按回车：直接带着它搜一次。
      useEffect(() => {
        const q = (initialQuery || '').trim()
        if (q) run(q, false)
      }, [])

      const onKeyDown = e => {
        if (e.nativeEvent?.isComposing || e.keyCode === 229) return // 中文输入法组字时不抢回车
        if (e.key === 'Escape') { e.preventDefault(); onClose(); return }
        if (e.key === 'ArrowDown') { e.preventDefault(); setSelected(i => Math.min(i + 1, Math.max(0, flat.length - 1))); return }
        if (e.key === 'ArrowUp') { e.preventDefault(); setSelected(i => Math.max(i - 1, 0)); return }
        if (e.key === 'Enter') {
          e.preventDefault()
          if (busy) return
          const query = text.trim()
          if (results && searched.current === query && flat.length) {
            onOpen(flat[Math.min(selected, flat.length - 1)].hit)
            return
          }
          run(query, includeTrash)
        }
      }

      const toggleTrash = e => {
        const next = e.target.checked
        setIncludeTrash(next)
        if (searched.current) run(searched.current, next)
      }

      return h('div', {
        className: 'beer-overlay', 'data-dsh-no-drag': '', onKeyDown,
        onClick: e => { if (e.target === e.currentTarget) onClose() },
      },
      h('div', { className: 'beer-modal', role: 'dialog', 'aria-label': '搜索整个 Obsidian 库' },
        h('div', { className: 'beer-searchhd' },
          h('span', { className: 'beer-muted' }, '⌕'),
          h('input', {
            ref: inputRef, value: text, 'aria-label': '搜索关键词',
            placeholder: '搜索整个库，或输入 #标签、状态:成稿、类型:链接',
            onChange: e => {
              setText(e.target.value)
              if (!e.target.value.trim()) { setResults(null); searched.current = null }
            },
          }),
          h('span', { className: 'beer-muted' }, busy ? '搜索中…' : results ? `共 ${results.total} 条` : ''),
          h('label', { className: 'beer-muted', style: { display: 'flex', gap: 4, alignItems: 'center' } },
            h('input', { type: 'checkbox', checked: includeTrash, onChange: toggleTrash }),
            '包括回收站')),
        h('div', { className: 'beer-sr' },
          !results && h('div', { className: 'beer-muted', style: { padding: '12px 10px' } },
            `输入关键词或条件，回车搜索；${SEARCH_KEY} 打开搜索，Esc 关闭。`),
          results?.error && h('div', { className: 'beer-err', style: { margin: '8px 10px' } }, results.error),
          results && !results.error && !results.total && h('div', { className: 'beer-muted', style: { padding: '12px 10px' } },
            '没有找到。试试更短的关键词，或者让 AI 在库里按意思找。'),
          (results?.groups ?? []).map(group => [
            h('div', { key: group.tabId + '-g', className: 'beer-sr-group' }, `${group.title} · ${group.hits.length}`),
            ...group.hits.map(hit => {
              const index = flat.findIndex(item => item.hit.path === hit.path && item.hit.tabId === hit.tabId)
              return h('div', {
                key: hit.path,
                className: 'beer-hit' + (index === selected ? ' on' : ''),
                role: 'option', tabIndex: -1, 'aria-selected': index === selected,
                onClick: () => onOpen(hit),
                onMouseEnter: () => setSelected(index),
              },
              h('div', { className: 'beer-hit-t' },
                h('b', null, hit.title),
                h('span', { className: 'beer-chip' }, KIND_LABELS[hit.kind] ?? '笔记'),
                hit.playAt != null && h('button', {
                  type: 'button',
                  className: 'beer-playchip',
                  title: `从文字稿 ${formatClock(hit.playAt)} 处开始播放`,
                  onClick: e => { e.stopPropagation(); onPlayFrom(hit) },
                }, `▶ ${formatClock(hit.playAt)}`),
                h('span', { className: 'beer-muted' },
                  (hit.matchedIn ?? []).map(field => MATCHED_LABELS[field]).filter(Boolean).join(' · '))),
              hit.snippet && h('div', { className: 'beer-hit-s' }, h(Highlighted, { text: hit.snippet, ranges: hit.highlights })),
              h('div', { className: 'beer-hit-act' },
                h('span', { className: 'beer-muted', style: { fontSize: '11px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 } }, hit.path),
                h('button', { onClick: e => { e.stopPropagation(); onAttach(hit) } }, '附到对话')))
            }),
          ])),
        h('div', { className: 'beer-searchft' },
          h('span', null, h('span', { className: 'beer-kbd' }, '↑↓'), ' 选择'),
          h('span', null, h('span', { className: 'beer-kbd' }, '↵'), ' 在工作台打开'),
          h('span', null, h('span', { className: 'beer-kbd' }, 'Esc'), ' 关闭'),
          h('button', { className: 'beer-linkbtn', onClick: () => onAskAI(text) }, '找不到？让 AI 在库里找 →'))))
    }

    // 自定义分页的「条目列表」样式：只读浏览，文件夹在前、可进入，Markdown 点开预览，不做编辑器。
    function EntryListView({ folder, tabId, tabTitle, onError, openRequest }) {
      const [dir, setDir] = useState(folder)
      const [listing, setListing] = useState(null)
      const [doc, setDoc] = useState(null)
      const [localInput, setLocalInput] = useState('')
      const [localResults, setLocalResults] = useState(null)
      const [localBusy, setLocalBusy] = useState(false)
      const localToken = useRef(0)
      const handledOpen = useRef(null)

      const loadDir = useCallback(async path => {
        try {
          setListing(await api('GET', '/library/folder?path=' + encodeURIComponent(path)))
          setDir(path)
          setDoc(null)
        } catch (e) { onError(e.message) }
      }, [onError])
      useEffect(() => { loadDir(folder) }, [folder, loadDir])

      const openFile = async path => {
        try { setDoc(await api('GET', '/library/file?path=' + encodeURIComponent(path))) }
        catch (e) { onError(e.message) }
      }

      // 从顶栏搜索打开这个分页里的文件：只影响右侧预览，不打断文件夹列表。
      useEffect(() => {
        if (!openRequest || handledOpen.current === openRequest.nonce) return
        handledOpen.current = openRequest.nonce
        openFile(openRequest.path)
      }, [openRequest])

      // 本页搜索：和笔记样式一样只搜当前分页绑定的文件夹。
      const runLocalSearch = useCallback(async query => {
        const token = ++localToken.current
        setLocalBusy(true)
        try {
          const result = await api('GET', '/search?q=' + encodeURIComponent(query) + '&scope=' + encodeURIComponent(tabId))
          if (localToken.current === token) setLocalResults(result)
        } catch (e) {
          if (localToken.current === token) setLocalResults({ query, total: 0, groups: [], error: e.message })
        } finally {
          if (localToken.current === token) setLocalBusy(false)
        }
      }, [tabId])
      useEffect(() => {
        const query = localInput.trim()
        if (!query) { localToken.current++; setLocalResults(null); setLocalBusy(false); return }
        const timer = setTimeout(() => runLocalSearch(query), 250)
        return () => clearTimeout(timer)
      }, [localInput, runLocalSearch])

      const crumbs = []
      if (dir !== folder) {
        const rel = dir.slice(folder.length + 1).split('/')
        crumbs.push(h('button', { key: 'root', onClick: () => loadDir(folder) }, folder.split('/').pop()))
        rel.forEach((name, idx) => {
          const target = folder + '/' + rel.slice(0, idx + 1).join('/')
          crumbs.push(h('span', { key: 's' + idx }, '/'))
          crumbs.push(idx === rel.length - 1 ? h('b', { key: target }, name) : h('button', { key: target, onClick: () => loadDir(target) }, name))
        })
      } else crumbs.push(h('b', { key: 'root' }, folder))

      const entries = listing?.entries ?? []
      const hint = text => h('div', { className: 'beer-muted' }, text)
      const searching = !!localInput.trim()
      const localGroups = localResults?.groups ?? []
      const localCount = localGroups.reduce((sum, group) => sum + group.hits.length, 0)
      const grid = searching
        ? (localBusy && !localResults ? hint('搜索中…')
          : localResults?.error ? hint(localResults.error)
            : !localCount ? hint('本页没有命中。')
              : h('div', { className: 'beer-grid' }, localGroups.flatMap(group => group.hits.map(hit => h('button', {
                key: hit.path,
                className: 'beer-tile' + (doc?.path === hit.path ? ' on' : ''),
                title: hit.path,
                onClick: () => openFile(hit.path),
              },
                h('b', null, hit.title),
                h('small', null, `${group.title} · ${(MATCHED_LABELS[hit.matchedIn[0]] ?? '命中')}`))))))
        : !listing ? hint('加载中…')
          : !listing.exists ? hint(`库里还没有「${dir}」这个文件夹。`)
            : !entries.length ? hint('这个文件夹是空的。')
              : h('div', { className: 'beer-grid' }, entries.map(e => {
                const md = e.kind === 'file' && /\.md$/i.test(e.name)
                return h('button', {
                  key: e.path,
                  className: 'beer-tile' + (doc?.path === e.path ? ' on' : ''),
                  disabled: e.kind === 'file' && !md,
                  title: e.kind === 'file' && !md ? `${e.name}（只能预览 Markdown 文件）` : e.path,
                  onClick: () => (e.kind === 'folder' ? loadDir(e.path) : openFile(e.path)),
                },
                  h('b', null, (e.kind === 'folder' ? '▸ ' : '') + e.name),
                  h('small', null, e.kind === 'folder' ? '文件夹' : md ? 'Markdown · ' + fmtTime(e.modifiedAt) : '不能预览'))
              }))

      return h('div', { className: 'beer-grid-view' },
        h('div', { className: 'beer-libsearch' },
          h('input', {
            value: localInput,
            placeholder: '只搜本页…',
            'aria-label': `在「${tabTitle || '本页'}」里搜索`,
            onChange: e => setLocalInput(e.target.value),
            onKeyDown: e => { if (e.key === 'Escape' && localInput) { e.stopPropagation(); setLocalInput('') } },
          }),
          localInput && h('button', { className: 'beer-btn ghost', onClick: () => setLocalInput('') }, '清空')),
        searching
          ? h('div', { className: 'beer-crumbs' },
            h('b', null, `本页搜索：${localInput.trim()}`),
            h('span', null, localBusy ? ' · 搜索中…' : localResults ? ` · ${localCount} 条` : ''))
          : h('div', { className: 'beer-crumbs', title: dir }, crumbs),
        grid,
        doc && h('div', { className: 'beer-pane beer-doc' },
          h('div', { className: 'beer-doc-hd' },
            h('b', { title: doc.path }, doc.path.split('/').pop()),
            h('button', { className: 'beer-btn', onClick: () => setDoc(null) }, '关闭预览')),
          h(MarkdownPreview, { source: doc.content, base: doc.path })))
    }

    // 「＋」新建自定义分页的小表单；文件夹可以填库里还不存在的路径，服务端会校验。
    function TabForm({ onCreate, onCancel }) {
      const [title, setTitle] = useState('')
      const [folder, setFolder] = useState('')
      const [style, setStyle] = useState('note')
      const [err, setErr] = useState('')
      const [busy, setBusy] = useState(false)

      const submit = async e => {
        e.preventDefault()
        if (busy) return
        if (!title.trim()) { setErr('标题不能为空'); return }
        if (!folder.trim()) { setErr('文件夹必须填库内的相对路径'); return }
        setBusy(true)
        try {
          const tab = await api('POST', '/panel/tabs', { title: title.trim(), folder: folder.trim(), style })
          await onCreate(tab)
        } catch (e) {
          setErr(e.message)
        } finally { setBusy(false) }
      }

      return h('form', { className: 'beer-tab-form', onSubmit: submit },
        h('label', null, '标题',
          h('input', {
            value: title, maxLength: 40, autoFocus: true, placeholder: '例如 读书笔记',
            onChange: e => setTitle(e.target.value), 'aria-label': '新分页标题',
          })),
        h('label', null, '库内文件夹',
          h('input', {
            value: folder, placeholder: '例如 内容库/读书笔记',
            onChange: e => setFolder(e.target.value), 'aria-label': '新分页文件夹',
          })),
        h('label', null, '样式',
          h('select', { value: style, onChange: e => setStyle(e.target.value), 'aria-label': '新分页样式' },
            h('option', { value: 'note' }, '笔记'),
            h('option', { value: 'list' }, '条目列表'))),
        h('div', { className: 'acts' },
          h('button', { type: 'button', className: 'beer-btn', onClick: onCancel }, '取消'),
          h('button', { type: 'submit', className: 'beer-btn pri', disabled: busy }, busy ? '创建中…' : '创建分页')),
        err && h('div', { className: 'beer-err', role: 'alert' }, err),
        h('div', { className: 'beer-muted' }, '文件夹用 / 分隔，可以填库里还没有的文件夹；创建分页不会新建或删除任何文件。'))
    }

    // ---- 文章分页：按状态筛选、新建、改状态 / 改标题、归档、删除、叫 AI 帮手 ----
    // 主稿正文由用户自己写；这里改状态只动开头属性，改标题只动正文第一个 # 行。
    const ARTICLE_FILTERS = [['', '全部'], ['选题', '选题'], ['草稿', '草稿'], ['成稿', '成稿'], ['已确认', '已确认'], ['已发布', '已发布'], ['已归档', '已归档']]
    const MANUAL_ARTICLE_STATUSES = ['选题', '草稿', '成稿']
    const ARTICLES_ARCHIVE = '内容库/文章/_归档'
    const ASSIST_KINDS = [['outline', '列提纲'], ['facts', '查事实'], ['counter', '提反对意见'], ['titles', '拟标题']]

    function firstHeading(content) {
      const m = /^#\s+(.+)$/m.exec(content || '')
      return m ? m[1].trim() : ''
    }

    /** 平台版本文件预览：frontmatter 由面板单独显示，这里只给正文。 */
    function withoutFrontmatter(content) {
      const text = content || ''
      if (!text.startsWith('---')) return text
      const end = text.indexOf('\n---', 3)
      return end < 0 ? text : text.slice(end + 4).replace(/^\n/, '')
    }

    // 把 prompt 追加到宿主对话草稿（用户自己发送）；拿不到会话或输入框时返回 false，由调用方退回剪贴板。
    function insertIntoDraft(panel, service, prompt) {
      const input = conversationInputOf(service, panel?.sessionId)
      if (!input) return false
      try { appendToDraft(input, prompt); return true } catch { return false }
    }

    function ArticlesView({ service, panel, narrow, onError, openRequest }) {
      const [filter, setFilter] = useState('')
      const [articles, setArticles] = useState(null)
      const [selectedPath, setSelectedPath] = useState(null)
      const [doc, setDoc] = useState(null) // { path, content, version, modifiedAt, openedAt }
      const [newTitle, setNewTitle] = useState('')
      const [titleDraft, setTitleDraft] = useState(null)
      const [editing, setEditing] = useState(false)
      const [bodyDraft, setBodyDraft] = useState('')
      const [busy, setBusy] = useState(false)
      const [hint, setHint] = useState('')
      const [assistPrompt, setAssistPrompt] = useState('')
      const [versions, setVersions] = useState(null) // 成稿的平台版本列表
      const [versionsBusy, setVersionsBusy] = useState(false)
      const [versionPreview, setVersionPreview] = useState(null) // { platform, path, content }
      const [versionDiff, setVersionDiff] = useState(null) // { platform, added, removed }
      const [hardWarnings, setHardWarnings] = useState([]) // 生成后硬规则检查的提醒
      const [hardCheckError, setHardCheckError] = useState('')

      const load = useCallback(async f => {
        try {
          const query = f ? '?status=' + encodeURIComponent(f) : ''
          const data = await api('GET', '/articles' + query)
          setArticles(data.articles)
          return data.articles
        } catch (e) { onError(e.message); return [] }
      }, [onError])
      useEffect(() => { load(filter) }, [filter, load])

      const loadVersions = useCallback(async path => {
        try {
          const data = await api('GET', '/articles/versions?path=' + encodeURIComponent(path))
          setVersions(data.versions)
        } catch (e) {
          setVersions([])
          onError(e.message)
        }
      }, [onError])

      // 搜索浮层按「文章」分页打开某条结果：切到对应筛选并加载那一份文件。
      useEffect(() => {
        const path = openRequest?.path
        if (!path) return
        let cancelled = false
        setFilter(path.startsWith(ARTICLES_ARCHIVE + '/') ? '已归档' : '')
        ;(async () => {
          try {
            const d = await api('GET', '/library/file?path=' + encodeURIComponent(path))
            if (cancelled) return
            setSelectedPath(path)
            setDoc({ ...d, openedAt: new Date().toISOString() })
            setTitleDraft(null)
            setEditing(false)
            setHint('')
            setAssistPrompt('')
            onError('')
          } catch (e) { if (!cancelled) onError(e.message) }
        })()
        return () => { cancelled = true }
      }, [openRequest, onError])

      const article = articles?.find(a => a.path === selectedPath) ?? null
      const currentStatus = article?.status ?? ''
      const locked = currentStatus === '已确认' || currentStatus === '已发布'
      const canManual = MANUAL_ARTICLE_STATUSES.includes(currentStatus)
      const shownTitle = doc ? (firstHeading(doc.content) || article?.title || '') : ''

      // 成稿才显示平台版本；主稿重新读入或保存后（版本标记变了）也刷新一次。
      useEffect(() => {
        setVersionPreview(null)
        setVersionDiff(null)
        setVersions(null)
        setHardWarnings([])
        setHardCheckError('')
        if (doc && currentStatus === '成稿') loadVersions(doc.path)
      }, [doc?.path, doc?.version, currentStatus, loadVersions])

      const openArticle = async item => {
        if (editing && !window.confirm('还有没保存的改动，确定放弃吗？')) return
        try {
          const d = await api('GET', '/library/file?path=' + encodeURIComponent(item.path))
          setSelectedPath(item.path)
          setDoc({ ...d, openedAt: new Date().toISOString() })
          setTitleDraft(null)
          setEditing(false)
          setHint('')
          setAssistPrompt('')
          onError('')
        } catch (e) {
          onError(e.message)
          await load(filter)
        }
      }

      const reloadDoc = async path => {
        try {
          const d = await api('GET', '/library/file?path=' + encodeURIComponent(path))
          setDoc({ ...d, openedAt: new Date().toISOString() })
          return d
        } catch (e) { onError(e.message); return null }
      }

      const refresh = async path => {
        const list = await load(filter)
        const item = list.find(a => a.path === path)
        if (item) {
          setSelectedPath(item.path)
          await reloadDoc(item.path)
        } else {
          setSelectedPath(null)
          setDoc(null)
        }
        return item
      }

      const create = async e => {
        e.preventDefault()
        if (busy) return
        if (editing && !window.confirm('还有没保存的改动，确定放弃吗？')) return
        const title = newTitle.trim()
        if (!title) { onError('文章标题不能为空'); return }
        setBusy(true)
        try {
          const created = await api('POST', '/articles', { title })
          setNewTitle('')
          setFilter('')
          await load('')
          const d = await api('GET', '/library/file?path=' + encodeURIComponent(created.path))
          setSelectedPath(created.path)
          setDoc({ ...d, openedAt: new Date().toISOString() })
          setTitleDraft(null)
          setEditing(false)
          setAssistPrompt('')
          setHint('已新建并打开。正文由你自己写。')
          onError('')
        } catch (e) { onError(e.message) } finally { setBusy(false) }
      }

      // 改状态 / 改标题 / 归档 / 删除都会重新读文件，编辑中的正文草稿会丢；先让用户保存或取消。
      const requireNotEditing = () => {
        if (!editing) return true
        onError('正在编辑正文：先保存或取消，再改状态、标题、归档或删除。')
        return false
      }

      // 切到「成稿」时先问一句：确认了才顺手生成平台版本，绝不自动生成。
      const changeStatus = async status => {
        if (!doc || !article || busy || status === article.status) return
        if (!requireNotEditing()) return
        const wantGenerate = status === '成稿' ? window.confirm('状态改为成稿。要现在生成平台版本吗？不生成也不影响主稿。') : false
        setBusy(true)
        try {
          const res = await api('POST', '/articles/status', { path: doc.path, status, baseVersion: doc.version })
          await refresh(doc.path)
          if (res.askGeneratePlatformVersions) {
            if (wantGenerate) await generateVersions(undefined, doc.path)
            else setHint('状态已改成成稿；没有生成平台版本，之后可以在这里手动生成。')
          } else {
            setHint('')
          }
          onError('')
        } catch (e) {
          if (e.code === 'edit_conflict') onError('这篇文章在别处被改过，没有改状态；请重新打开后再试。')
          else onError(e.message)
        } finally { setBusy(false) }
      }

      const saveTitle = async e => {
        e.preventDefault()
        if (!doc || busy) return
        if (!requireNotEditing()) return
        const title = (titleDraft ?? '').trim()
        if (!title) { onError('文章标题不能为空'); return }
        setBusy(true)
        try {
          await api('POST', '/articles/title', { path: doc.path, title, baseVersion: doc.version })
          setTitleDraft(null)
          await refresh(doc.path)
          setHint('标题已改：只改了正文标题，文件夹名和开头属性都没动。')
          onError('')
        } catch (e) {
          if (e.code === 'edit_conflict') onError('这篇文章在别处被改过，没有改标题；请重新打开后再试。')
          else onError(e.message)
        } finally { setBusy(false) }
      }

      const startEdit = () => { setBodyDraft(doc.content); setEditing(true); setHint('') }
      const cancelEdit = () => { setEditing(false); setHint('') }
      const saveBody = async () => {
        if (!doc || busy) return
        setBusy(true)
        try {
          const r = await api('PUT', '/library/file', { path: doc.path, content: bodyDraft, baseVersion: doc.version })
          setDoc({ ...doc, content: bodyDraft, version: r.version, modifiedAt: r.modifiedAt, openedAt: new Date().toISOString() })
          setEditing(false)
          await load(filter)
          setHint('已保存。')
          onError('')
        } catch (e) {
          if (e.code === 'edit_conflict') onError('这篇文章在别处被改过，没有保存；原文件保持不变。')
          else onError(e.message)
        } finally { setBusy(false) }
      }

      const archive = async () => {
        if (!doc || busy) return
        if (!requireNotEditing()) return
        if (!window.confirm('把整篇文章移到 文章/_归档？之后可以在「已归档」里找到它。')) return
        setBusy(true)
        try {
          await api('POST', '/articles/archive', { path: doc.path })
          setSelectedPath(null)
          setDoc(null)
          setEditing(false)
          setTitleDraft(null)
          setAssistPrompt('')
          setHint('已归档。')
          await load(filter)
          onError('')
        } catch (e) { onError(e.message) } finally { setBusy(false) }
      }

      const remove = async () => {
        if (!doc || busy || locked) return
        if (!requireNotEditing()) return
        if (!window.confirm('把这篇文章移到回收站？之后可以在「回收站」分页恢复。')) return
        setBusy(true)
        try {
          await api('POST', '/articles/delete', { path: doc.path })
          setSelectedPath(null)
          setDoc(null)
          setEditing(false)
          setTitleDraft(null)
          setAssistPrompt('')
          setHint('已移到回收站。')
          await load(filter)
          onError('')
        } catch (e) { onError(e.message) } finally { setBusy(false) }
      }

      const assist = async kind => {
        if (!doc) return
        try {
          const { prompt } = await api('GET', `/articles/assist?path=${encodeURIComponent(doc.path)}&kind=${kind}`)
          if (insertIntoDraft(panel, service, prompt)) {
            setAssistPrompt('')
            setHint('已把 prompt 放进右侧对话草稿（不会自动发送）。')
          } else {
            const copied = await copyText(prompt)
            setAssistPrompt(prompt)
            setHint(copied
              ? '没有可用的对话会话，prompt 已复制到剪贴板，粘贴到对话里即可。'
              : '没有可用的对话会话，剪贴板也不可用，请手动复制下面的 prompt。')
          }
          onError('')
        } catch (e) { onError(e.message) }
      }

      // ---- 平台版本：按平台改写主稿，主稿不动；改过的版本只提示、不覆盖 ----
      const showHardWarnings = result => {
        setHardWarnings(Array.isArray(result?.hardRuleWarnings) ? result.hardRuleWarnings : [])
        setHardCheckError(typeof result?.hardRuleCheckError === 'string' ? result.hardRuleCheckError : '')
      }

      const generateVersions = async (platforms, path = doc?.path) => {
        if (!path || versionsBusy) return
        setVersionsBusy(true)
        setVersionDiff(null)
        setVersionPreview(null)
        setHardWarnings([])
        setHardCheckError('')
        try {
          const body = { path }
          if (platforms) body.platforms = platforms
          const result = await api('POST', '/articles/versions/generate', body)
          showHardWarnings(result)
          await loadVersions(path)
          setHint(platforms ? `已生成${platforms.join('、')}版本；主稿没有改动。` : '已生成知乎、小红书版本；主稿没有改动。')
          onError('')
        } catch (e) {
          if (e.code === 'version_user_edited') {
            setVersionDiff({ platform: e.body?.platform || '', ...(e.body?.mainDraftChanges || { added: [], removed: [] }) })
            onError('这个平台版本你改过，没有覆盖；下面是主稿的改动。')
          } else onError(e.message)
        } finally { setVersionsBusy(false) }
      }

      const regenerateVersion = async platform => {
        if (!doc || versionsBusy) return
        setVersionsBusy(true)
        setVersionDiff(null)
        setVersionPreview(null)
        setHardWarnings([])
        setHardCheckError('')
        try {
          const result = await api('POST', '/articles/versions/regenerate', { path: doc.path, platform })
          showHardWarnings(result)
          await loadVersions(doc.path)
          setHint(`已重新生成${platform}版本；主稿没有改动。`)
          onError('')
        } catch (e) {
          if (e.code === 'version_user_edited') {
            setVersionDiff({ platform: e.body?.platform || platform, ...(e.body?.mainDraftChanges || { added: [], removed: [] }) })
            onError(`${platform}版本你改过，没有覆盖；下面是主稿的改动。`)
          } else onError(e.message)
        } finally { setVersionsBusy(false) }
      }

      // 用户改过平台版本（通常在 Obsidian 里）后，把「生成时 → 改后」交给规则学习。
      const observeVersion = async version => {
        if (versionsBusy) return
        setVersionsBusy(true)
        try {
          const result = await api('POST', '/rules/observe', { path: version.path, platform: version.platform })
          if (result.observed) {
            const learned = result.added?.length
              ? `归纳出 ${result.added.length} 条：${result.added.map(item => item.rule).join('；')}`
              : '这次没有归纳出新规则'
            setHint(`已观察「${version.platform}」的改稿，${learned}。${result.pending?.length ? '有规则可以到「规则」分页转正了。' : ''}`)
          } else if (result.reason === 'disabled') {
            setHint('规则学习已关闭；到「规则」分页打开后再观察。')
          } else if (result.reason === 'no_snapshot') {
            setHint('这一版没有生成时的快照，不能学习；先重新生成一次再改稿。')
          } else {
            setHint(`「${version.platform}」版本和生成时一样，没有可学习的改动。`)
          }
          onError('')
        } catch (e) { onError(e.message) } finally { setVersionsBusy(false) }
      }

      const previewVersion = async version => {
        try {
          const d = await api('GET', '/library/file?path=' + encodeURIComponent(version.path))
          setVersionPreview({ platform: version.platform, path: version.path, content: d.content })
          onError('')
        } catch (e) { onError(e.message) }
      }

      const hintLine = text => h('div', { className: 'beer-muted', style: { padding: '0 8px' } }, text)
      const listPane = h('div', { className: 'beer-pane beer-list', style: { width: 300 } },
        h('div', { className: 'beer-art-new' },
          h('form', { onSubmit: create },
            h('input', {
              value: newTitle, maxLength: 120, placeholder: '新文章标题', 'aria-label': '新文章标题',
              onChange: e => setNewTitle(e.target.value),
            }),
            h('button', { className: 'beer-btn pri', type: 'submit', disabled: busy }, '＋ 新建'))),
        h('div', { className: 'beer-filters' }, ARTICLE_FILTERS.map(([value, label]) =>
          h('button', {
            key: value || 'all', type: 'button',
            className: 'beer-filter' + (filter === value ? ' on' : ''),
            'aria-pressed': filter === value,
            onClick: () => {
              if (editing && !window.confirm('还有没保存的改动，确定放弃吗？')) return
              setFilter(value)
              setSelectedPath(null)
              setDoc(null)
              setEditing(false)
              setTitleDraft(null)
              setHint('')
              setAssistPrompt('')
            },
          }, label))),
        !articles ? hintLine('加载中…')
          : !articles.length ? hintLine(filter ? '这个状态下没有文章。' : '还没有文章；在上面输入标题新建一篇。')
            : articles.map(item => h('button', {
              key: item.path,
              className: 'beer-art' + (item.path === selectedPath ? ' on' : ''),
              title: item.folder,
              onClick: () => openArticle(item),
            },
              h('b', null, item.title || '（无标题）'),
              h('span', { className: 'row' },
                h('span', { className: 'beer-chip' }, item.status || '无状态'),
                h('span', { className: 'beer-muted' }, item.date || '')))))

      // 平台版本区：只在成稿显示；改过的版本只给提示和 diff，不提供覆盖。
      const versionsArea = currentStatus === '成稿' && h('div', { className: 'beer-versions' },
        h('div', { className: 'beer-version-hd' },
          h('b', null, '平台版本'),
          h('button', { className: 'beer-btn pri', disabled: versionsBusy, onClick: () => generateVersions() },
            versionsBusy ? '处理中…' : '生成平台版本'),
          h('button', { className: 'beer-btn', disabled: versionsBusy, onClick: () => generateVersions(['知乎']) }, '只生成知乎'),
          h('button', { className: 'beer-btn', disabled: versionsBusy, onClick: () => generateVersions(['小红书']) }, '只生成小红书')),
        versions === null
          ? h('div', { className: 'beer-muted' }, '加载中…')
          : versions.length === 0
            ? h('div', { className: 'beer-muted' }, '还没有平台版本。生成时按平台改写，主稿不会改动。')
            : versions.map(version => h('div', { key: version.platform, className: 'beer-version' },
              h('span', { className: 'name' }, version.platform),
              h('span', { className: 'beer-muted' }, version.generatedAt ? new Date(version.generatedAt).toLocaleString() : '没有生成记录'),
              version.action === 'regenerate'
                ? h('span', { className: 'beer-chip warn' }, '主稿已更新 · 可重新生成')
                : version.action === 'prompt_only'
                  ? h('span', { className: 'beer-chip bad' }, '主稿已更新 · 你改过，不覆盖')
                  : h('span', { className: 'beer-chip' }, '正常'),
              h('button', { className: 'beer-btn ghost', onClick: () => previewVersion(version) }, '预览'),
              h('button', { className: 'beer-btn', disabled: versionsBusy, onClick: () => observeVersion(version), title: '在 Obsidian 里改过这一版后，把改动交给规则学习' }, '观察改稿'),
              h('button', { className: 'beer-btn', disabled: versionsBusy, onClick: () => regenerateVersion(version.platform) }, '重新生成'))),
        (hardWarnings.length > 0 || hardCheckError) && h('div', { className: 'beer-rule-warns' },
          hardWarnings.length > 0 && h('b', null, '硬规则提醒'),
          hardWarnings.map((item, i) => h('div', { key: i },
            `${item.platform ? item.platform + '：' : ''}${item.rule}${item.reason ? ' —— ' + item.reason : ''}`)),
          hardCheckError && h('div', null, `硬规则检查没做完：${hardCheckError}`)),
        versionDiff && h('div', { className: 'beer-version-diff' },
          h('div', null, `主稿改了这些地方（${versionDiff.platform || '平台版本'}不会覆盖）：`),
          (versionDiff.added || []).map((line, i) => h('div', { key: 'a' + i, className: 'add' }, '+ ' + (line || '（空行）'))),
          (versionDiff.removed || []).map((line, i) => h('div', { key: 'r' + i, className: 'del' }, '- ' + (line || '（空行）'))),
          !(versionDiff.added || []).length && !(versionDiff.removed || []).length &&
            h('div', { className: 'beer-muted' }, '生成时的主稿快照不在了，看不出具体改了哪些行。')),
        versionPreview && h('div', { className: 'beer-version-prev' },
          h('div', { className: 'beer-version-hd' },
            h('b', null, versionPreview.platform + '版本预览'),
            h('span', { className: 'beer-muted', title: versionPreview.path }, versionPreview.path),
            h('button', { className: 'beer-btn ghost', onClick: () => setVersionPreview(null) }, '关闭预览')),
          h(MarkdownPreview, { source: withoutFrontmatter(versionPreview.content), base: versionPreview.path })))

      let detail
      if (!doc) {
        detail = h('div', { className: 'beer-pane beer-doc' },
          h('div', { className: 'beer-prev beer-muted' }, '从左边选一篇文章预览；或用「＋ 新建」建一篇，正文由你自己写。'))
      } else {
        const statusControls = canManual
          ? h('select', {
            value: currentStatus, 'aria-label': '文章状态', disabled: busy,
            onChange: e => changeStatus(e.target.value),
          }, MANUAL_ARTICLE_STATUSES.map(s => h('option', { key: s, value: s }, s)))
          : h('span', { className: 'beer-chip' + (locked ? ' bad' : '') }, currentStatus || '无状态')
        detail = h('div', { className: 'beer-pane beer-doc' },
          h('div', { className: 'beer-art-title' },
            titleDraft === null
              ? [h('b', { key: 't', title: doc.path }, shownTitle || article?.title || '（无标题）'),
                h('span', { key: 's' }, statusControls),
                h('button', {
                  key: 'e', className: 'beer-btn ghost',
                  onClick: () => { if (requireNotEditing()) { setTitleDraft(shownTitle || article?.title || ''); setHint('') } },
                }, '改标题')]
              : h('form', { onSubmit: saveTitle, style: { display: 'flex', gap: '6px', flex: '1 1 100%', alignItems: 'center' } },
                h('input', {
                  value: titleDraft, autoFocus: true, 'aria-label': '新的文章标题',
                  onChange: e => setTitleDraft(e.target.value),
                }),
                h('button', { className: 'beer-btn', type: 'button', onClick: () => setTitleDraft(null) }, '取消'),
                h('button', { className: 'beer-btn pri', type: 'submit', disabled: busy }, '保存标题'))),
          !canManual && h('div', { className: 'beer-muted', style: { padding: '0 12px 6px' } },
            locked ? `「${currentStatus}」不能手动改状态，只能由发布流程改。` : '这篇文章开头没有可用的状态，不能在这里改。'),
          h('div', { className: 'beer-art-actions' },
            h('span', { className: 'beer-muted', title: article?.folder || doc.path }, article?.folder || doc.path),
            editing
              ? [h('button', { key: 's', className: 'beer-btn pri', onClick: saveBody, disabled: busy }, '保存 ⌘S'),
                h('button', { key: 'c', className: 'beer-btn', onClick: cancelEdit }, '取消')]
              : h('button', { className: 'beer-btn', onClick: startEdit }, '编辑正文'),
            !article?.archived && h('button', { className: 'beer-btn', onClick: archive, disabled: busy }, '归档'),
            currentStatus === '已发布'
              ? h('button', { className: 'beer-btn', disabled: true, title: '已发布的文章不能删除，只能归档' }, '删除')
              : h('button', { className: 'beer-btn', onClick: remove, disabled: busy }, '删除')),
          h('div', { className: 'beer-assist' },
            h('span', { className: 'beer-muted' }, 'AI 帮手'),
            ASSIST_KINDS.map(([kind, label]) =>
              h('button', { key: kind, className: 'beer-btn', onClick: () => assist(kind) }, label))),
          hint && h('div', { className: 'beer-muted', style: { padding: '5px 12px' } }, hint),
          assistPrompt && h('div', { className: 'beer-assist' },
            h('textarea', {
              readOnly: true, value: assistPrompt, rows: 4, 'aria-label': 'AI 帮手 prompt',
              onFocus: e => e.target.select(),
            }),
            h('button', {
              className: 'beer-btn',
              onClick: () => copyText(assistPrompt),
            }, '再次复制')),
          versionsArea,
          editing
            ? h(LiveEditor, { value: bodyDraft, onChange: setBodyDraft, onSave: saveBody, onError, base: doc.path, ariaLabel: '编辑文章正文' })
            : h(MarkdownPreview, { source: doc.content, base: doc.path }))
      }

      return h('div', { className: 'beer-lib' + (narrow ? ' narrow' : '') }, listPane, detail)
    }

    // ---- 选题分页：当天简报、角度卡片（建选题 / 和 AI 讨论）、重新生成、状态为「选题」的文章 ----
    // 简报由服务端每天第一次打开时生成；「重新生成」会覆盖当天文件。
    function TopicsView({ service, panel, onError, onOpenArticles }) {
      const [data, setData] = useState(null)
      const [busy, setBusy] = useState('')
      const [hint, setHint] = useState('')
      const [loadError, setLoadError] = useState('')
      const [promptText, setPromptText] = useState('')
      const [matOpen, setMatOpen] = useState(false)
      const [materials, setMaterials] = useState(null)
      const [selectedMats, setSelectedMats] = useState([])
      const [topicPath, setTopicPath] = useState('')
      const [adding, setAdding] = useState(false)
      const [matMsg, setMatMsg] = useState('')

      const load = useCallback(async assure => {
        try {
          setData(await api('GET', '/topics' + (assure ? '?ensure=1' : '')))
          setLoadError('')
          onError('')
        } catch (e) {
          setLoadError(e.message)
          onError(e.message)
        }
      }, [onError])
      useEffect(() => { load(true) }, [load])

      const regenerate = async () => {
        if (busy) return
        if (!window.confirm('重新生成今天的选题简报？会覆盖当天这份文件。')) return
        setBusy('brief')
        setPromptText('')
        try {
          setData(await api('POST', '/topics/brief/regenerate'))
          setHint('已重新生成今天的选题简报。')
          onError('')
        } catch (e) { onError(e.message) } finally { setBusy('') }
      }

      // 选中角度 → 新建状态为「选题」的文章，然后切到文章分页继续写。
      const createTopic = async angle => {
        if (busy) return
        setBusy(angle.title)
        try {
          const created = await api('POST', '/topics/articles', {
            title: angle.title, why: angle.why, materials: angle.materials,
          })
          setHint(`已建出选题「${created.title}」，可以到文章分页继续写。`)
          onError('')
          await load(false)
          if (onOpenArticles) onOpenArticles(created.path)
        } catch (e) { onError(e.message) } finally { setBusy('') }
      }

      // 和 AI 讨论：把带当天简报和角度的 prompt 放进右侧对话草稿，不自动发送。
      const discuss = async angle => {
        if (busy) return
        setBusy(angle.title)
        try {
          const { prompt } = await api('GET',
            `/topics/discuss?angle=${encodeURIComponent(angle.title)}&why=${encodeURIComponent(angle.why || '')}`)
          if (insertIntoDraft(panel, service, prompt)) {
            setPromptText('')
            setHint('已把讨论 prompt 放进右侧对话草稿（不会自动发送）。')
          } else {
            const copied = await copyText(prompt)
            setPromptText(prompt)
            setHint(copied
              ? '没有可用的对话会话，prompt 已复制到剪贴板，粘贴到对话里即可。'
              : '没有可用的对话会话，剪贴板也不可用，请手动复制下面的 prompt。')
          }
          onError('')
        } catch (e) { onError(e.message) } finally { setBusy('') }
      }

      const toggleMatMode = async () => {
        if (matOpen) { setMatOpen(false); return }
        setMatOpen(true)
        setMatMsg('')
        if (!materials) {
          try {
            const list = await api('GET', '/materials')
            setMaterials(list.entries)
          } catch (e) { onError(e.message) }
        }
        if (!topicPath && data?.topics?.length) setTopicPath(data.topics[0].path)
      }

      const toggleMat = path => setSelectedMats(prev =>
        prev.includes(path) ? prev.filter(item => item !== path) : [...prev, path])

      const addMaterials = async () => {
        if (!topicPath) { setMatMsg('先选一篇「选题」文章。'); return }
        if (!selectedMats.length) { setMatMsg('先勾选要放进去的素材。'); return }
        setAdding(true)
        setMatMsg('')
        try {
          const res = await api('POST', '/topics/materials', { path: topicPath, materials: selectedMats })
          setMatMsg(`已放进选题，现在共 ${res.materials.length} 条素材。`)
          setSelectedMats([])
          onError('')
        } catch (e) { setMatMsg(e.message) } finally { setAdding(false) }
      }

      if (!data) {
        return loadError
          ? h('div', { className: 'beer-card' },
            h('div', { className: 'beer-err' }, loadError),
            h('button', { className: 'beer-btn pri', onClick: () => load(true) }, '重试'))
          : h('div', { className: 'beer-muted' }, '加载中…')
      }
      const angles = data.angles ?? []
      const topics = data.topics ?? []

      const angleCards = angles.map(angle => h('div', { key: angle.title, className: 'beer-angle' },
        h('h3', null, angle.title),
        h('div', { className: 'why' }, angle.why || '（模型没有给出理由）'),
        angle.materials?.length > 0 && h('div', { className: 'refs' },
          angle.materials.map(ref => h('span', { key: ref, className: 'beer-chip' }, ref))),
        h('div', { className: 'acts' },
          h('button', {
            className: 'beer-btn pri', disabled: !!busy,
            onClick: () => createTopic(angle),
          }, busy === angle.title ? '处理中…' : '建选题'),
          h('button', {
            className: 'beer-btn', disabled: !!busy,
            onClick: () => discuss(angle),
          }, '和 AI 讨论'))))

      const topicList = h('div', { className: 'beer-topic-list' },
        topics.length
          ? topics.map(item => h('button', {
            key: item.path, className: 'beer-art', title: item.folder,
            onClick: () => onOpenArticles?.(item.path),
          },
            h('b', null, item.title || '（无标题）'),
            h('span', { className: 'row' },
              h('span', { className: 'beer-chip' }, item.status || '选题'),
              h('span', { className: 'beer-muted' }, item.date || ''))))
          : h('div', { className: 'beer-muted', style: { padding: '4px 8px' } },
            '还没有选题。从上面的角度里挑一个点「建选题」，或在文章分页手动新建。'))

      // 多选素材放进选题：勾选素材卡片、选择一篇「选题」文章、调用 /topics/materials。
      const materialPicker = matOpen && h('div', { className: 'beer-topic-brief' },
        h('div', { className: 'beer-rowo', style: { padding: '9px 0 4px' } },
          h('b', null, '多选素材放进选题'),
          h('span', { className: 'beer-muted' },
            selectedMats.length ? `已选 ${selectedMats.length} 条` : '勾选下面的素材，再选一篇「选题」文章。'),
          h('button', { className: 'beer-btn ghost', style: { marginLeft: 'auto' }, onClick: toggleMatMode }, '收起')),
        !topics.length
          ? h('div', { className: 'beer-muted' }, '还没有状态为「选题」的文章，先在上面建一个。')
          : h('div', { className: 'beer-matselectbar' },
            h('span', { className: 'beer-muted' }, '放进'),
            h('select', {
              className: 'beer-mat-select', value: topicPath, 'aria-label': '放进哪篇选题',
              onChange: e => setTopicPath(e.target.value),
            },
              h('option', { value: '' }, '选择选题…'),
              topics.map(item => h('option', { key: item.path, value: item.path }, item.title || item.path))),
            h('button', {
              className: 'beer-btn pri', disabled: adding || !selectedMats.length || !topicPath,
              onClick: addMaterials,
            }, adding ? '放入中…' : '放进选题'),
            h('button', {
              className: 'beer-btn ghost', onClick: () => setSelectedMats([]),
              disabled: !selectedMats.length,
            }, '清空勾选'),
            matMsg && h('span', { className: 'beer-muted' }, matMsg)),
        !materials
          ? h('div', { className: 'beer-muted' }, '加载素材中…')
          : !materials.length
            ? h('div', { className: 'beer-muted' }, '素材文件夹还是空的。')
            : h('div', { className: 'beer-cards', style: { padding: '8px 0' } }, materials.map(entry => h('button', {
              key: entry.path,
              className: 'beer-matcard' + (selectedMats.includes(entry.path) ? ' on' : ''),
              title: entry.path,
              onClick: () => toggleMat(entry.path),
            },
              h('div', { className: 'beer-matcard-hd' },
                h('span', { className: 'beer-matcheck' }, selectedMats.includes(entry.path) ? '✓' : ''),
                h('b', null, entry.title),
                entry.type && h('span', { className: 'beer-chip' }, entry.type)),
              entry.tags?.length > 0 && h('div', { className: 'beer-tags' },
                entry.tags.map(tag => h('span', { key: tag, className: 'beer-chip' }, '#' + tag))),
              entry.summary && h('div', { className: 'beer-sum' }, entry.summary)))))

      return h('div', { className: 'beer-topics' },
        h('div', { className: 'beer-topic-hd' },
          h('b', null, `${data.date} 选题简报`),
          h('span', { className: 'beer-muted', title: data.briefPath }, data.briefPath),
          h('button', { className: 'beer-btn', disabled: busy === 'brief', onClick: () => load(true) }, '刷新'),
          h('button', { className: 'beer-btn', disabled: busy === 'brief', onClick: toggleMatMode }, matOpen ? '收起多选素材' : '多选素材 → 放入选题'),
          h('button', { className: 'beer-btn pri', disabled: busy === 'brief', onClick: regenerate },
            busy === 'brief' ? '生成中…' : '重新生成')),
        hint && h('div', { className: 'beer-muted' }, hint),
        promptText && h('div', { className: 'beer-assist' },
          h('textarea', {
            readOnly: true, value: promptText, rows: 5, 'aria-label': '讨论角度的 prompt',
            onFocus: e => e.target.select(),
          }),
          h('button', { className: 'beer-btn', onClick: () => copyText(promptText) }, '再次复制')),
        materialPicker,
        data.exists
          ? (angles.length
            ? h('div', null,
              h('div', { className: 'beer-topic-sec' }, `AI 建议的角度（${angles.length}）`),
              h('div', { className: 'beer-topics' }, angleCards))
            : h('div', { className: 'beer-topic-brief' },
              h('div', { className: 'beer-muted', style: { padding: '9px 0' } },
                '这份简报里没有解析出角度（模型可能没有按 JSON 回复）。原文在下面，可以点「重新生成」再试一次。'),
              h(MarkdownPreview, { source: withoutFrontmatter(data.content) })))
          : h('div', { className: 'beer-topic-brief' },
            h('div', { className: 'beer-muted', style: { padding: '9px 0' } },
              '今天还没有选题简报。'),
            h('button', { className: 'beer-btn pri', disabled: busy === 'brief', onClick: () => load(true) }, '生成今天的简报')),
        h('div', { className: 'beer-topic-sec' }, `已选定的选题（${topics.length}）`),
        topicList,
        data.exists && data.content && h('details', { className: 'beer-topic-brief' },
          h('summary', null, '简报原文'),
          h(MarkdownPreview, { source: withoutFrontmatter(data.content) })))
      }

    // ---- 发布分页：成稿 / 已确认列表，主稿与平台版本逐行对照，确认后发布到 Rin 博客 ----
    // 主稿只是对照的基准，这里不编辑正文；发布失败时留在「已确认」，可以重试。
    // 知乎、小红书没有自动发布接口：准备发布包（文字进剪贴板、图片复制到库外文件夹）后打开发布页，
    // 用户自己粘贴、上传、点发布；回来填链接写进 发布记录.md。不自动登录、不自动提交。
    function PublishView({ narrow, onError }) {
      const [articles, setArticles] = useState(null)
      const [selectedPath, setSelectedPath] = useState(null)
      const [busy, setBusy] = useState(false)
      const [notice, setNotice] = useState(null) // { kind: 'ok' | 'bad', text }
      const [showPublished, setShowPublished] = useState(false) // 补记录 / 重看包时把已发布也列出来
      const [pack, setPack] = useState(null) // 最近一次手动准备的发布包
      const [packages, setPackages] = useState(null) // 确认发布后顺手备好的知乎 / 小红书发布包
      const [blockedPackages, setBlockedPackages] = useState([]) // 发布页被浏览器拦住的平台
      const [packageCopyFailed, setPackageCopyFailed] = useState([]) // 文字没能自动复制的平台
      const [packBusy, setPackBusy] = useState('') // 正在准备哪个平台的包
      const [copyFailed, setCopyFailed] = useState(false)
      const [openBlocked, setOpenBlocked] = useState(false)
      const [recordPlatform, setRecordPlatform] = useState('知乎')
      const [recordUrl, setRecordUrl] = useState('')
      const [recordBusy, setRecordBusy] = useState(false)
      const [recordText, setRecordText] = useState(null) // 当前文章的 发布记录.md 内容

      const fetchArticles = useCallback(async includePublished => {
        try {
          const data = await api('GET', '/publish' + (includePublished ? '?includePublished=1' : ''))
          setArticles(data.articles)
          return data.articles
        } catch (e) {
          onError(e.message)
          setArticles([])
          return []
        }
      }, [onError])
      const load = useCallback(() => fetchArticles(showPublished), [fetchArticles, showPublished])
      useEffect(() => { load() }, [load])

      // 发布成功后文章不再属于待发布，选中项自动落到下一篇。
      useEffect(() => {
        if (!articles) return
        if (!articles.some(a => a.path === selectedPath)) setSelectedPath(articles[0]?.path ?? null)
      }, [articles, selectedPath])

      const current = articles?.find(a => a.path === selectedPath) ?? null

      // 发布记录：只显示当前文章那一份，记录成功后重新读一次。
      const recordPathOf = path => path.replace(/\/index\.md$/i, '') + '/发布记录.md'
      const loadRecord = useCallback(async path => {
        if (!path) { setRecordText(null); return }
        try {
          const file = await api('GET', '/library/file?path=' + encodeURIComponent(recordPathOf(path)))
          setRecordText(file.content)
        } catch (e) {
          setRecordText(e.status === 404 ? '' : null)
        }
      }, [])
      useEffect(() => { loadRecord(current?.path) }, [current?.path, loadRecord])

      const publish = async () => {
        if (!current) return
        setBusy(true)
        setNotice(null)
        const retry = current.status === '已确认'
        let published = false
        try {
          const result = await api('POST', retry ? '/publish/retry' : '/publish/confirm', { path: current.path })
          published = true
          // 确认发布成功时，服务端顺手备好了知乎 / 小红书发布包。先在这些包的发布页上
          // 尝试 window.open（仍然是在这次点击的同一段处理里）；被拦的包下面给可点链接。
          const prepared = Array.isArray(result.packages) ? result.packages : []
          const blocked = []
          for (const pkg of prepared) {
            let opened = null
            try { opened = window.open(pkg.publishUrl, '_blank') } catch {}
            if (!opened) blocked.push(pkg.platform)
          }
          setPackages(prepared)
          setBlockedPackages(blocked)
          setPackageCopyFailed([])
          const packNote = prepared.length
            ? ` 顺手备好了 ${prepared.map(pkg => `「${pkg.platform}」`).join('、')}发布包；文字可在下面复制，发布页没打开时点链接。`
            : ''
          const packError = result.packageError ? ` 发布包没能备好：${result.packageError}` : ''
          setNotice({
            kind: 'ok',
            text: `已发布到 Rin 博客（${result.feedId}），状态改成「已发布」，发布记录写进了 ${result.record}。${packNote}${packError}`,
          })
          onError('')
          // 发布成功后这篇文章变成「已发布」：打开「含已发布」，让它留在列表里，
          // 这样顺手备好的知乎 / 小红书发布包能继续显示，也方便补链接。
          if (!showPublished) setShowPublished(true)
        } catch (e) {
          setNotice({ kind: 'bad', text: `发布失败：${e.message}` })
        } finally {
          setBusy(false)
          await loadRecord(current.path)
          // 成功后要把「已发布」这篇留在列表里给发布包用；失败时按原来的筛选刷新。
          await fetchArticles(published ? true : showPublished)
        }
      }

      // 准备知乎 / 小红书发布包：文字写进剪贴板，图片在库外文件夹，再打开发布页。
      const openPackage = async platform => {
        if (!current) return
        setPackBusy(platform)
        setNotice(null)
        setRecordPlatform(platform)
        try {
          const result = await api('POST', '/publish/package', { path: current.path, platform })
          setPack(result)
          const copied = await copyText(result.text)
          setCopyFailed(!copied)
          let opened = null
          try { opened = window.open(result.publishUrl, '_blank') } catch {}
          setOpenBlocked(!opened)
          const where = opened ? '发布页已经打开' : '发布页被拦住了，点下面的链接打开'
          setNotice({
            kind: 'ok',
            text: copied
              ? `「${platform}」的文字已复制到剪贴板，${result.images.length} 张图片已备好；${where}。粘贴后自己点发布。`
              : `「${platform}」的文字没能自动复制，请在下框里手动全选复制；${where}。`,
          })
          onError('')
        } catch (e) {
          setNotice({ kind: 'bad', text: `准备发布包失败：${e.message}` })
        } finally {
          setPackBusy('')
        }
      }

      const record = async () => {
        if (!current) return
        const url = recordUrl.trim()
        if (!url) {
          setNotice({ kind: 'bad', text: '先填发布后的链接（http 或 https 开头）' })
          return
        }
        setRecordBusy(true)
        setNotice(null)
        const statusChanged = current.status === '已确认'
        try {
          const result = await api('POST', '/publish/record', { path: current.path, platform: recordPlatform, url })
          setRecordUrl('')
          setNotice({
            kind: 'ok',
            text: `已记到 ${result.record}${result.appended ? '' : '（这条链接之前已经记过，没有重复写）'}${statusChanged ? '，主稿状态改成「已发布」' : ''}。`,
          })
          onError('')
          await loadRecord(result.path)
          // 状态刚变成已发布：打开「含已发布」，让这篇留在列表里，方便继续给另一个平台补链接。
          if (result.status === '已发布' && !showPublished) setShowPublished(true)
          else await fetchArticles(showPublished)
        } catch (e) {
          setNotice({ kind: 'bad', text: `记录发布链接失败：${e.message}` })
        } finally {
          setRecordBusy(false)
        }
      }

      // 确认发布时顺手备好的包：文字按平台单独复制，复制失败时下面出现可全选的文本框。
      const copyPackageText = async pkg => {
        const copied = await copyText(pkg.text)
        setPackageCopyFailed(list => copied
          ? list.filter(platform => platform !== pkg.platform)
          : (list.includes(pkg.platform) ? list : [...list, pkg.platform]))
        setNotice({
          kind: copied ? 'ok' : 'bad',
          text: copied
            ? `「${pkg.platform}」的文字已复制到剪贴板。`
            : `「${pkg.platform}」的文字没能自动复制，请在下框里手动全选复制。`,
        })
      }

      const resetPack = () => {
        setPack(null)
        setPackages(null)
        setBlockedPackages([])
        setPackageCopyFailed([])
        setCopyFailed(false)
        setOpenBlocked(false)
        setRecordUrl('')
        setNotice(null)
      }

      const listPane = h('div', { className: 'beer-pane beer-list beer-pub-list' },
        h('div', { className: 'beer-trash-hd' },
          h('b', null, showPublished ? '发布' : '待发布'),
          h('span', { className: 'beer-muted' }, showPublished ? '成稿、已确认、已发布' : '成稿、已确认'),
          h('label', {
            className: 'beer-pub-toggle',
            title: '已发布的文章可以重看发布包，或补另一个平台的链接',
          },
          h('input', {
            type: 'checkbox',
            checked: showPublished,
            onChange: e => setShowPublished(e.target.checked),
          }), '含已发布')),
        articles === null
          ? h('div', { className: 'beer-muted', style: { padding: '4px 8px' } }, '加载中…')
          : articles.length === 0
            ? h('div', { className: 'beer-muted', style: { padding: '4px 8px' } }, '还没有待发布的文章。')
            : articles.map(item => h('button', {
              key: item.path,
              className: 'beer-item' + (item.path === current?.path ? ' on' : ''),
              title: item.path,
              onClick: () => { setSelectedPath(item.path); resetPack() },
            },
            h('span', null, item.title || '（无标题）'),
            h('span', { className: 'beer-chip' + (item.status === '已确认' ? ' warn' : '') }, item.status))))

      let detail
      if (!current) {
        detail = h('div', { className: 'beer-pane beer-pub-doc' },
          h('div', { className: 'beer-pub-empty' }, articles === null
            ? '加载中…'
            : showPublished
              ? '还没有成稿、已确认或已发布的文章。'
              : '还没有成稿或已确认的文章。文章状态改成「成稿」后就会出现在这里。'))
      } else {
        const versions = current.versions || []
        const canPackage = current.status === '已确认' || current.status === '已发布'
        const packageButtons = canPackage && h('div', { className: 'beer-pub-acts' },
          h('b', null, '发布包'),
          h('button', {
            className: 'beer-btn',
            onClick: () => openPackage('知乎'),
            disabled: !!packBusy || busy,
          }, packBusy === '知乎' ? '准备中…' : '知乎发布包'),
          h('button', {
            className: 'beer-btn',
            onClick: () => openPackage('小红书'),
            disabled: !!packBusy || busy,
          }, packBusy === '小红书' ? '准备中…' : '小红书发布包'),
          h('span', { className: 'beer-muted' }, '只准备文字和图片，不会自动登录或自动提交；粘贴后自己在网页上点发布。'))

        const recordForm = canPackage && h('div', { className: 'beer-pub-acts' },
          h('b', null, '已发布？'),
          h('select', {
            className: 'beer-pub-select',
            value: recordPlatform,
            onChange: e => setRecordPlatform(e.target.value),
            'aria-label': '记录的平台',
          }, ['知乎', '小红书', 'Rin 博客'].map(p => h('option', { key: p, value: p }, p))),
          h('input', {
            className: 'beer-pub-url',
            type: 'url',
            placeholder: '发布后的链接 https://…',
            value: recordUrl,
            onChange: e => setRecordUrl(e.target.value),
            onKeyDown: e => { if (e.key === 'Enter') record() },
            'aria-label': '发布后的链接',
          }),
          h('button', { className: 'beer-btn', onClick: record, disabled: recordBusy },
            recordBusy ? '记录中…' : '已发布，填链接'),
          h('span', { className: 'beer-muted' }, current.status === '已确认'
            ? '写进条目的 发布记录.md；同一条链接不会重复写，状态从「已确认」改成「已发布」。'
            : '写进条目的 发布记录.md；这篇已经是「已发布」，只追加记录。'))

        const packBlock = pack && h('div', { className: 'beer-pub-block' },
          h('div', { className: 'beer-pub-block-hd' },
            h('b', null, pack.platform + '发布包'),
            h('span', { className: 'beer-muted' }, `${pack.images.length} 张图片 · 文字${copyFailed ? '需要手动复制' : '已复制到剪贴板'}`)),
          h('div', { className: 'beer-pub-pack-body' },
            copyFailed
              ? h('textarea', {
                className: 'beer-editor',
                style: { minHeight: '140px', maxHeight: '260px', flex: 'none', border: '1px solid var(--line)', borderRadius: '8px' },
                readOnly: true,
                autoFocus: true,
                spellCheck: false,
                value: pack.text,
                onFocus: e => e.target.select(),
                'aria-label': '发布包文字，请手动全选复制',
              })
              : h('div', { className: 'beer-muted' }, '文字已经在剪贴板里。要重新复制，再点一次上面的发布包按钮。'),
            h('div', null, h('b', null, '包目录：'), h('div', { className: 'beer-pub-path' }, pack.packageDir)),
            pack.images.length === 0
              ? h('div', { className: 'beer-muted' }, '条目 images/ 下没有图片，包里只有文字。')
              : h('div', null,
                h('b', null, '图片：'),
                pack.images.map(image => h('div', { key: image.name, className: 'beer-pub-img', title: image.source },
                  `${image.name} → ${image.copiedTo}`))),
            openBlocked
              ? h('a', { href: pack.publishUrl, target: '_blank', rel: 'noreferrer', className: 'beer-pub-link' },
                '打开发布页：' + pack.publishUrl)
              : h('div', { className: 'beer-muted' }, '发布页：' + pack.publishUrl),
            h('div', { className: 'beer-muted' },
              '把文字粘到发布页，图片用上面的文件夹手动上传；确认内容后自己点发布，不会自动登录或自动提交。')))

        // 确认发布后服务端顺手备好的包：每个平台一块，文字可以单独复制，发布页被拦时给链接。
        const packagesBlock = (packages || []).map(pkg => h('div', { key: pkg.platform, className: 'beer-pub-block' },
          h('div', { className: 'beer-pub-block-hd' },
            h('b', null, pkg.platform + '发布包'),
            h('span', { className: 'beer-muted' }, `${pkg.images.length} 张图片 · 确认发布时已备好`)),
          h('div', { className: 'beer-pub-pack-body' },
            h('div', null, h('b', null, '包目录：'), h('div', { className: 'beer-pub-path' }, pkg.packageDir)),
            pkg.images.length === 0
              ? h('div', { className: 'beer-muted' }, '条目 images/ 下没有图片，包里只有文字。')
              : h('div', null,
                h('b', null, '图片：'),
                pkg.images.map(image => h('div', { key: image.name, className: 'beer-pub-img', title: image.source },
                  `${image.name} → ${image.copiedTo}`))),
            blockedPackages.includes(pkg.platform)
              ? h('a', { href: pkg.publishUrl, target: '_blank', rel: 'noreferrer', className: 'beer-pub-link' },
                '打开发布页：' + pkg.publishUrl)
              : h('div', { className: 'beer-muted' }, '发布页已打开：' + pkg.publishUrl),
            h('button', { className: 'beer-btn', onClick: () => copyPackageText(pkg) },
              `复制「${pkg.platform}」文字`),
            packageCopyFailed.includes(pkg.platform) && h('textarea', {
              className: 'beer-editor',
              style: { minHeight: '140px', maxHeight: '260px', flex: 'none', border: '1px solid var(--line)', borderRadius: '8px' },
              readOnly: true,
              spellCheck: false,
              value: pkg.text,
              onFocus: e => e.target.select(),
              'aria-label': `${pkg.platform}发布包文字，请手动全选复制`,
            }),
            h('div', { className: 'beer-muted' },
              '复制文字、上传图片后自己在网页上点发布；Beer 不会自动登录或提交。'))))

        const recordBlock = canPackage && h('div', { className: 'beer-pub-block' },
          h('div', { className: 'beer-pub-block-hd' },
            h('b', null, '发布记录'),
            h('span', { className: 'beer-muted', title: recordPathOf(current.path) }, recordPathOf(current.path))),
          h('div', { className: 'beer-pub-record' }, recordText === null
            ? '加载中…'
            : recordText.trim()
              ? recordText
              : '还没有发布记录。'))

        detail = h('div', { className: 'beer-pane beer-pub-doc' },
          h('div', { className: 'beer-pub-hd' },
            h('b', { title: current.path }, current.title || '（无标题）'),
            h('span', { className: 'beer-chip' + (current.status === '已确认' ? ' warn' : '') }, current.status),
            h('span', { className: 'beer-muted', title: current.path }, current.path)),
          current.status === '已发布'
            ? h('div', { className: 'beer-pub-acts' },
              h('span', { className: 'beer-muted' }, '这篇已经发布过了；这里可以用来重看发布包、给知乎 / 小红书补链接。'))
            : h('div', { className: 'beer-pub-acts' },
              h('button', { className: 'beer-btn pri', onClick: publish, disabled: busy },
                busy ? '发布中…' : current.status === '已确认' ? '重试发布到 Rin 博客' : '确认并发布到 Rin 博客'),
              h('span', { className: 'beer-muted' }, current.status === '已确认'
                ? '已确认但还没发布成功；重试只重跑发布，不会再改一次状态。'
                : '确认后先把状态改成「已确认」，发布成功再改成「已发布」，正文一个字节都不动。')),
          packageButtons,
          recordForm,
          notice && h('div', {
            className: notice.kind === 'bad' ? 'beer-err' : 'beer-toast',
            role: notice.kind === 'bad' ? 'alert' : 'status',
          }, notice.text),
          h('div', { className: 'beer-pub-body' },
            ...packagesBlock,
            packBlock,
            recordBlock,
            h('div', { className: 'beer-pub-block' },
              h('div', { className: 'beer-pub-block-hd' },
                h('b', null, '主稿'),
                h('span', { className: 'beer-muted' }, '逐行对照的基准')),
              h('div', { className: 'beer-pub-main' }, h(MarkdownPreview, { source: current.main, base: current.path }))),
            versions.length === 0
              ? h('div', { className: 'beer-muted' }, '这篇文章还没有平台版本，只会发布主稿。')
              : versions.map(version => {
                const added = version.diff.filter(line => line.type === 'added').length
                const removed = version.diff.filter(line => line.type === 'removed').length
                return h('div', { key: version.platform, className: 'beer-pub-block' },
                  h('div', { className: 'beer-pub-block-hd' },
                    h('b', null, version.platform + '版本'),
                    version.userEdited
                      ? h('span', { className: 'beer-chip bad' }, '你改过')
                      : h('span', { className: 'beer-chip' }, '生成后未改'),
                    h('span', { className: 'beer-muted' }, `相对主稿 +${added} −${removed} 行`)),
                  h('div', { className: 'beer-pub-diff' },
                    version.diff.map((line, i) => h('div', {
                      key: i,
                      className: line.type === 'added' ? 'added' : line.type === 'removed' ? 'removed' : 'same',
                    }, (line.type === 'added' ? '+ ' : line.type === 'removed' ? '- ' : '  ') + (line.text === '' ? ' ' : line.text)))))
              })))
      }

      return h('div', { className: 'beer-pub' + (narrow ? ' narrow' : '') }, listPane, detail)
    }

    // ---- 回收站：列 .trash 里的项，逐项恢复，或手动清空（需确认；没有自动清理） ----
    function TrashView({ onError, openRequest }) {
      const [items, setItems] = useState(null)
      const [busy, setBusy] = useState(false)
      const [preview, setPreview] = useState(null) // 从搜索打开回收站里的 Markdown：只读预览
      const handledOpen = useRef(null)

      const load = useCallback(async () => {
        try { setItems((await api('GET', '/trash')).items) } catch (e) { onError(e.message) }
      }, [onError])
      useEffect(() => { load() }, [load])

      useEffect(() => {
        if (!openRequest || handledOpen.current === openRequest.nonce) return
        handledOpen.current = openRequest.nonce
        api('GET', '/library/file?path=' + encodeURIComponent(openRequest.path))
          .then(setPreview)
          .catch(e => onError(e.message))
      }, [openRequest])

      const restore = async item => {
        setBusy(true)
        try {
          await api('POST', '/trash/restore', { id: item.id })
          onError('')
          await load()
        } catch (e) { onError(e.message) } finally { setBusy(false) }
      }

      const clear = async () => {
        if (!window.confirm('确定清空回收站？里面的东西会被永久删除，不能恢复。')) return
        setBusy(true)
        try {
          await api('DELETE', '/trash')
          onError('')
          await load()
        } catch (e) { onError(e.message) } finally { setBusy(false) }
      }

      if (!items) return h('div', { className: 'beer-muted' }, '加载中…')
      return h('div', { className: 'beer-trash' },
        h('div', { className: 'beer-trash-hd' },
          h('b', null, `回收站（${items.length}）`),
          h('span', { className: 'beer-muted' }, '删除的东西都移到了库里的 .trash，只有你按「清空回收站」才会真的删掉。'),
          h('button', { className: 'beer-btn', onClick: clear, disabled: busy || !items.length }, '清空回收站…')),
        !items.length
          ? h('div', { className: 'beer-muted' }, '回收站是空的。')
          : items.map(item => h('div', { key: item.id, className: 'beer-trash-item' },
            h('div', { className: 'beer-trash-main' },
              h('b', { title: item.originalPath }, item.originalPath),
              h('span', { className: 'beer-muted' },
                `${item.kind === 'folder' ? '文件夹' : '文件'} · ${fmtSize(item.size)} · ${fmtTime(item.deletedAt)} 删除`)),
            h('button', { className: 'beer-btn', onClick: () => restore(item), disabled: busy }, '恢复'))),
        preview && h('div', { className: 'beer-pane beer-doc', style: { maxHeight: '50vh' } },
          h('div', { className: 'beer-doc-hd' },
            h('b', { title: preview.path }, preview.path),
            h('button', { className: 'beer-btn', onClick: () => setPreview(null) }, '关闭预览')),
          h(MarkdownPreview, { source: preview.content, base: preview.path })))
    }

    // ---- 规则分页：开关、硬 / 软规则、待转正规则和观察次数 ----

    function RuleGroup({ title, rules, empty }) {
      return h('div', { className: 'beer-rule-group' },
        h('b', null, `${title}（${rules.length}）`),
        rules.length === 0
          ? h('div', { className: 'beer-muted' }, empty)
          : rules.map(rule => h('div', { key: rule, className: 'beer-rule-item' },
            h('span', { className: 'beer-rule-text' }, rule))))
    }

    function RulesView({ onError }) {
      const [data, setData] = useState(null)
      const [busy, setBusy] = useState(false)
      const [notice, setNotice] = useState('')

      const load = useCallback(async () => {
        try {
          const next = await api('GET', '/rules')
          setData(next)
          onError('')
        } catch (e) { onError(e.message) }
      }, [onError])
      useEffect(() => { load() }, [load])

      const toggle = async () => {
        if (!data || busy) return
        const next = !data.enabled
        setBusy(true)
        try {
          await api('PUT', '/rules/settings', { enabled: next })
          await load()
          setNotice(next
            ? '已打开规则学习：之后的改稿可以观察，生成平台版本时会检查硬规则。'
            : '已关闭规则学习：之后的改稿不再学习，生成平台版本也不检查规则。')
          onError('')
        } catch (e) { onError(e.message) } finally { setBusy(false) }
      }

      const promote = async (rule, kind) => {
        if (busy) return
        setBusy(true)
        try {
          await api('POST', '/rules/promote', { rule, kind })
          await load()
          setNotice(`「${rule}」已设为${kind === 'hard' ? '硬规则' : '软规则'}。`)
          onError('')
        } catch (e) { onError(e.message) } finally { setBusy(false) }
      }

      if (!data) return h('div', { className: 'beer-muted' }, '加载中…')
      return h('div', { className: 'beer-rules' },
        h('div', { className: 'beer-rule-head' },
          h('div', null,
            h('b', null, '规则学习'),
            h('div', { className: 'beer-muted' },
              '从你改过的知乎 / 小红书版本里归纳写作规则；同一条规则观察满 3 次才能转正，转正时由你决定放硬规则还是软规则。')),
          h('label', { className: 'beer-switch' },
            h('input', {
              type: 'checkbox', checked: data.enabled, disabled: busy,
              onChange: toggle, 'aria-label': '打开规则学习',
            }),
            h('span', null, data.enabled ? '已打开' : '已关闭（默认）'))),
        h('div', { className: 'beer-muted' },
          '硬规则在生成平台版本后检查并提醒；软规则只作为生成时的提示。关闭时不做任何学习，也不读写规则文件。'),
        notice && h('div', { className: 'beer-muted' }, notice),
        h(RuleGroup, { title: '硬规则', rules: data.hard, empty: '还没有硬规则。' }),
        h(RuleGroup, { title: '软规则', rules: data.soft, empty: '还没有软规则。' }),
        h('div', { className: 'beer-rule-group' },
          h('b', null, `待转正（观察满 3 次，${data.pending.length}）`),
          data.pending.length === 0
            ? h('div', { className: 'beer-muted' },
              data.enabled ? '还没有观察满 3 次的规则。改完平台版本后，到「文章」分页点「观察改稿」。' : '规则学习已关闭；打开后才会积累。')
            : data.pending.map(item => h('div', { key: item.rule, className: 'beer-rule-item' },
              h('span', { className: 'beer-rule-text' }, item.rule),
              h('span', { className: 'beer-chip warn' }, `观察 ${item.count} 次`),
              h('button', { className: 'beer-btn pri', disabled: busy, onClick: () => promote(item.rule, 'hard') }, '设为硬规则'),
              h('button', { className: 'beer-btn', disabled: busy, onClick: () => promote(item.rule, 'soft') }, '设为软规则')))),
        h('div', { className: 'beer-rule-group' },
          h('b', null, `观察次数（${data.observations.length}）`),
          data.observations.length === 0
            ? h('div', { className: 'beer-muted' }, '还没有观察到规则。')
            : data.observations.map(item => h('div', { key: item.rule, className: 'beer-rule-item' },
              h('span', { className: 'beer-rule-text' }, item.rule),
              h('span', { className: 'beer-chip' + (item.count >= 3 ? ' warn' : '') }, `${item.count} / 3 次`)))))
    }

    // ---- 首页：今日任务、录音进度、本周产出、规则积累和当天选题简报 ----
    // 只调 /home?ensure=1 和 /topics 读汇总，不碰会话；每天第一次打开会让服务端补生成简报，
    // 同一天文件已存在时不会重复调模型。没有会话时照常可用。

    function HomeStat({ value, label }) {
      return h('div', { className: 'beer-home-stat' }, h('b', null, String(value)), h('span', null, label))
    }

    function HomeView({ narrow, onOpenTab, onOpenConflict, onError }) {
      const [home, setHome] = useState(null)
      const [topics, setTopics] = useState(null)
      const [busy, setBusy] = useState(false)
      const [hint, setHint] = useState('')

      const load = useCallback(async () => {
        try {
          // ensure=1：每天第一次打开时，今天还没有简报就让服务端生成；已有文件不重复调模型。
          // 必须等它返回再读 /topics，并发读会拿到生成前的空简报，预览显示「还没有」。
          const nextHome = await api('GET', '/home?ensure=1')
          const nextTopics = await api('GET', '/topics')
          setHome(nextHome)
          setTopics(nextTopics)
          onError('')
        } catch (e) { onError(e.message) }
      }, [onError])
      useEffect(() => { load() }, [load])

      const regenerate = async () => {
        if (busy) return
        if (topics?.exists && !window.confirm('重新生成今天的选题简报？会覆盖当天这份文件。')) return
        setBusy(true)
        setHint('')
        try {
          await api('POST', '/home/brief/regenerate')
          setHint('已重新生成今天的选题简报。')
          onError('')
          await load()
        } catch (e) { onError(e.message) } finally { setBusy(false) }
      }

      if (!home) return h('div', { className: 'beer-muted' }, '加载中…')

      const { tasks, recordings, week, rules } = home
      const pending = tasks.publishPending ?? []
      const conflicts = tasks.editConflicts ?? []
      const openCount = pending.length + (tasks.brief.generatedToday ? 0 : 1) + conflicts.length

      const taskButton = (key, chip, chipClass, title, titleAttr, onClick) => h('button', {
        key, type: 'button', className: 'beer-home-task', title: titleAttr, onClick,
      },
        h('span', { className: 'beer-chip' + (chipClass ? ' ' + chipClass : '') }, chip),
        h('b', null, title),
        h('span', { className: 'go' }, '去处理 →'))

      return h('div', { className: 'beer-home' + (narrow ? ' narrow' : '') },
        h('div', { className: 'beer-home-tile wide' },
          h('div', { className: 'beer-home-row' },
            h('b', null, '等你处理'),
            h('span', { className: 'beer-chip' + (openCount ? ' bad' : '') }, String(openCount))),
          openCount === 0 && h('div', { className: 'beer-muted' }, '今天没有要处理的事。'),
          pending.map(item => taskButton('publish-' + item.path, item.status,
            item.status === '成稿' ? 'warn' : '', item.title, item.path, () => onOpenTab('publish'))),
          taskButton('brief',
            tasks.brief.generatedToday ? '新选题简报' : '还没有简报',
            tasks.brief.generatedToday ? '' : 'warn',
            tasks.brief.generatedToday ? `${home.date} 的选题简报已生成` : '今天还没有选题简报',
            tasks.brief.path,
            () => onOpenTab('topics')),
          conflicts.map(item => taskButton('conflict-' + item.path, '冲突', 'bad',
            item.path, item.detectedAt, () => onOpenConflict(item.path)))),
        h('div', { className: 'beer-home-tile' },
          h('div', { className: 'beer-home-row' },
            h('b', null, '录音'),
            h('span', { className: 'beer-muted', style: { marginLeft: 'auto' } },
              recordings.online ? '家里在线' : '家里暂时连不上')),
          !recordings.online
            ? h('div', { className: 'beer-err', style: { margin: 0 } }, recordings.error || '家里暂时连不上')
            : (recordings.processing.length === 0 && recordings.failedCount === 0
              ? h('div', { className: 'beer-muted' }, '没有正在处理的录音。')
              : null),
          recordings.online && recordings.processing.map(rec => h('div', { key: rec.id, className: 'beer-home-rec' },
            h('div', { className: 'beer-home-row' },
              h('b', { title: rec.filename }, rec.filename || '未命名录音'),
              h('span', { className: 'beer-muted', style: { marginLeft: 'auto' } },
                `${rec.step || '处理中'} ${rec.progress}%`)),
            h('div', { className: 'beer-bar' },
              h('i', { style: { width: Math.max(2, rec.progress) + '%' } })))),
          recordings.online && recordings.failedCount > 0 &&
            h('div', { className: 'beer-chip bad' }, `${recordings.failedCount} 条失败`),
          h('button', { className: 'beer-linkbtn', onClick: () => onOpenTab('recordings') }, '去录音页 →')),
        h('div', { className: 'beer-home-tile' },
          h('div', { className: 'beer-home-row' },
            h('b', null, '本周产出'),
            h('span', { className: 'beer-muted', style: { marginLeft: 'auto' } }, `周一起 · ${week.since}`)),
          h('div', { className: 'beer-home-stats' },
            h(HomeStat, { value: week.materials, label: '新素材' }),
            h(HomeStat, { value: week.drafts, label: '成稿' }),
            h(HomeStat, { value: week.published, label: '已发布' }))),
        h('div', { className: 'beer-home-tile' },
          h('div', { className: 'beer-home-row' },
            h('b', null, '规则积累'),
            h('span', { className: 'beer-chip', style: { marginLeft: 'auto' } }, rules.enabled ? '已开启' : '未开启')),
          h('div', { className: 'beer-home-stats' },
            h(HomeStat, { value: rules.hard, label: '硬规则' }),
            h(HomeStat, { value: rules.soft, label: '软规则' }),
            h(HomeStat, { value: rules.pending, label: '待转正' })),
          h('button', { className: 'beer-linkbtn', onClick: () => onOpenTab('rules') }, '去规则页 →')),
        h('div', { className: 'beer-home-tile full' },
          h('div', { className: 'beer-home-row' },
            h('b', null, '今天的选题简报'),
            h('span', {
              className: 'beer-muted',
              style: { flex: '1 1 160px', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
              title: tasks.brief.path,
            }, tasks.brief.path),
            h('button', { className: 'beer-btn pri', onClick: regenerate, disabled: busy },
              busy ? '生成中…' : (topics?.exists ? '重新生成' : '生成今天的简报'))),
          hint && h('div', { className: 'beer-muted' }, hint),
          tasks.brief.error && h('div', { className: 'beer-muted' },
            `今天的选题简报没能自动生成：${tasks.brief.error}；可以点上面的按钮重试。`),
          topics?.content
            ? h('div', { className: 'beer-home-brief' },
              h(MarkdownPreview, { source: withoutFrontmatter(topics.content) }))
            : h('div', { className: 'beer-muted' }, '今天还没有选题简报，点上面的按钮生成。')))
    }

    // ---- 素材分页：类型 / 标签 / 状态筛选、素材卡片、标签表编辑；点卡片用 LibraryView 预览 ----

    function MaterialsView({ narrow, onError, openRequest }) {
      const [data, setData] = useState(null)
      const [filter, setFilter] = useState({ type: '', tag: '', status: '' })
      const [detail, setDetail] = useState(null)
      const [ready, setReady] = useState(false)
      const [editingTags, setEditingTags] = useState(false)
      const [tagDraft, setTagDraft] = useState([])
      const [tagInput, setTagInput] = useState('')
      const [tagMsg, setTagMsg] = useState('')
      const [savingTags, setSavingTags] = useState(false)
      // 多选素材 → 放进选题（#13）：勾选卡片，选一篇状态为「选题」的文章，调 /topics/materials。
      const [selectMode, setSelectMode] = useState(false)
      const [selected, setSelected] = useState([])
      const [topics, setTopics] = useState(null)
      const [topicPath, setTopicPath] = useState('')
      const [adding, setAdding] = useState(false)
      const [selectMsg, setSelectMsg] = useState('')

      const load = useCallback(async () => {
        const params = new URLSearchParams()
        for (const key of ['type', 'tag', 'status']) if (filter[key]) params.set(key, filter[key])
        const suffix = params.toString() ? '?' + params.toString() : ''
        try {
          setData(await api('GET', '/materials' + suffix))
          onError('')
        } catch (e) { onError(e.message) }
      }, [filter, onError])

      // 第一次打开素材页：先建出 素材/说明.md 和 素材/标签表.md（已有的不动），再读列表。
      useEffect(() => {
        let alive = true
        api('POST', '/materials/init').catch(() => {}).then(() => { if (alive) setReady(true) })
        return () => { alive = false }
      }, [])
      useEffect(() => { if (ready) load() }, [ready, load])

      // 搜索里点到素材页的命中：直接进那一条的预览。
      const handledOpen = useRef(null)
      useEffect(() => {
        if (!openRequest || handledOpen.current === openRequest.nonce) return
        handledOpen.current = openRequest.nonce
        const parent = openRequest.path.includes('/') ? openRequest.path.slice(0, openRequest.path.lastIndexOf('/')) : '内容库/素材'
        setDetail({ path: openRequest.path, folder: parent, title: openRequest.path.split('/').pop(), type: '', tags: [] })
      }, [openRequest])

      const choose = patch => setFilter(f => ({ ...f, ...patch }))

      const openTagEditor = () => {
        setTagDraft(data?.tags ?? [])
        setTagInput('')
        setTagMsg('')
        setEditingTags(true)
      }

      const addTag = e => {
        e.preventDefault()
        const tag = tagInput.trim()
        if (!tag) return
        if (tagDraft.includes(tag)) { setTagMsg('这个标签已经在表里了'); return }
        if (tagDraft.length >= 100) { setTagMsg('标签表最多 100 个标签'); return }
        setTagDraft([...tagDraft, tag])
        setTagInput('')
        setTagMsg('')
      }

      const saveTags = async () => {
        if (savingTags) return
        setSavingTags(true)
        setTagMsg('')
        try {
          const res = await api('PUT', '/materials/tags', { tags: tagDraft })
          setTagDraft(res.tags)
          setData(d => (d ? { ...d, tags: res.tags } : d))
          if (filter.tag && !res.tags.includes(filter.tag)) choose({ tag: '' })
          setTagMsg('已保存到 内容库/素材/标签表.md')
          onError('')
        } catch (e) { setTagMsg(e.message) } finally { setSavingTags(false) }
      }

      // 多选：进入时读一遍状态为「选题」的文章；点卡片改成勾选，退出后恢复预览。
      const toggleSelectMode = async () => {
        if (selectMode) {
          setSelectMode(false)
          setSelected([])
          setSelectMsg('')
          return
        }
        setSelectMode(true)
        setSelectMsg('')
        try {
          const res = await api('GET', '/articles?status=' + encodeURIComponent('选题'))
          setTopics(res.articles)
          if (!topicPath && res.articles.length) setTopicPath(res.articles[0].path)
          onError('')
        } catch (e) { onError(e.message) }
      }

      const toggleSelected = path => setSelected(prev =>
        prev.includes(path) ? prev.filter(item => item !== path) : [...prev, path])

      const addSelected = async () => {
        if (!topicPath) { setSelectMsg('先选一篇「选题」文章。'); return }
        if (!selected.length) { setSelectMsg('先勾选要放进去的素材。'); return }
        setAdding(true)
        setSelectMsg('')
        try {
          const res = await api('POST', '/topics/materials', { path: topicPath, materials: selected })
          setSelectMsg(`已放进选题，现在共 ${res.materials.length} 条素材。`)
          setSelected([])
          onError('')
        } catch (e) { setSelectMsg(e.message) } finally { setAdding(false) }
      }

      // 点素材卡片 → 用现有的 LibraryView 打开那一条（自动预览它的 index.md）。
      if (detail) {
        return h('div', { className: 'beer-mat-detail' },
          h('div', { className: 'beer-mat-bar' },
            h('button', { className: 'beer-btn', onClick: () => setDetail(null) }, '← 素材列表'),
            h('b', { title: detail.path }, detail.title),
            detail.type && h('span', { className: 'beer-chip' }, detail.type),
            detail.tags?.length > 0 && h('span', { className: 'beer-tags' }, detail.tags.map(tag => h('span', { key: tag, className: 'beer-chip' }, '#' + tag)))),
          h(LibraryView, {
            key: detail.path,
            folder: detail.folder,
            tabId: 'materials',
            tabTitle: '素材',
            openRequest: { tabId: 'materials', path: detail.path, nonce: 'materials:' + detail.path },
            narrow,
            onError,
          }))
      }

      const types = data?.types ?? []
      const tags = data?.tags ?? []
      const statuses = data?.statuses ?? []
      const entries = data?.entries ?? []
      const filtered = !!(filter.type || filter.tag || filter.status)

      const tagEditor = editingTags && h('div', { className: 'beer-tagbar' },
        h('div', { className: 'beer-rowo' },
          h('b', null, '素材标签表'),
          h('span', { className: 'beer-muted' }, '素材标签只能从这张表里选；也可以直接在 Obsidian 里改 内容库/素材/标签表.md'),
          h('button', { className: 'beer-btn ghost', style: { marginLeft: 'auto' }, onClick: () => setEditingTags(false) }, '收起')),
        h('div', { className: 'beer-tags' },
          tagDraft.length
            ? tagDraft.map(tag => h('span', { key: tag, className: 'beer-tagchip' }, tag,
              h('button', { onClick: () => setTagDraft(tagDraft.filter(t => t !== tag)), 'aria-label': `删除标签 ${tag}` }, '×')))
            : h('span', { className: 'beer-muted' }, '标签表是空的。')),
        h('form', { className: 'beer-rowo', onSubmit: addTag },
          h('input', { className: 'beer-taginput', value: tagInput, onChange: e => setTagInput(e.target.value), placeholder: '新增标签名', 'aria-label': '新增标签名' }),
          h('button', { type: 'submit', className: 'beer-btn' }, '添加'),
          h('button', { type: 'button', className: 'beer-btn pri', onClick: saveTags, disabled: savingTags }, savingTags ? '保存中…' : '保存标签表')),
        tagMsg && h('div', { className: tagMsg.startsWith('已保存') ? 'beer-muted' : 'beer-err' }, tagMsg))

      return h('div', { className: 'beer-mat' },
        h('div', { className: 'beer-mat-filters' },
          h('div', { className: 'beer-rowo' },
            h('span', { className: 'beer-flabel' }, '类型'),
            [['全部', ''], ...types.map(t => [t, t])].map(([label, value]) =>
              h('button', {
                key: value || 'all',
                className: 'beer-pill' + (filter.type === value ? ' on' : ''),
                'aria-pressed': filter.type === value,
                onClick: () => choose({ type: value }),
              }, label))),
          h('div', { className: 'beer-rowo' },
            h('span', { className: 'beer-flabel' }, '标签'),
            h('select', {
              className: 'beer-mat-select', value: filter.tag, 'aria-label': '按标签筛选',
              onChange: e => choose({ tag: e.target.value }),
            }, h('option', { value: '' }, '全部标签'), tags.map(tag => h('option', { key: tag, value: tag }, tag))),
            statuses.length > 0 && h('span', { className: 'beer-flabel' }, '状态'),
            statuses.length > 0 && h('select', {
              className: 'beer-mat-select', value: filter.status, 'aria-label': '按状态筛选',
              onChange: e => choose({ status: e.target.value }),
            }, h('option', { value: '' }, '全部状态'), statuses.map(status => h('option', { key: status, value: status }, status))),
            filtered && h('button', { className: 'beer-btn ghost', onClick: () => setFilter({ type: '', tag: '', status: '' }) }, '清除筛选'),
            h('button', { className: 'beer-btn', style: { marginLeft: 'auto' }, onClick: editingTags ? () => setEditingTags(false) : openTagEditor },
              editingTags ? '收起标签表' : '标签表…'),
            h('button', { className: 'beer-btn' + (selectMode ? ' pri' : ''), onClick: toggleSelectMode },
              selectMode ? '退出多选' : '多选素材'))),
        tagEditor,
        // 多选素材放进选题：选一篇「选题」文章，勾选卡片后调用 /topics/materials。
        selectMode && h('div', { className: 'beer-matselectbar' },
          h('b', null, `已选 ${selected.length} 条`),
          topics === null
            ? h('span', { className: 'beer-muted' }, '正在读选题…')
            : !topics.length
              ? h('span', { className: 'beer-muted' }, '还没有状态为「选题」的文章；先在选题分页建一个。')
              : h('select', {
                className: 'beer-mat-select', value: topicPath, 'aria-label': '放进哪篇选题',
                onChange: e => setTopicPath(e.target.value),
              },
                h('option', { value: '' }, '选择「选题」文章…'),
                topics.map(item => h('option', { key: item.path, value: item.path }, item.title || item.path))),
          h('button', {
            className: 'beer-btn pri',
            disabled: adding || !selected.length || !topicPath,
            onClick: addSelected,
          }, adding ? '放入中…' : '放进选题'),
          h('button', {
            className: 'beer-btn ghost', disabled: !selected.length,
            onClick: () => setSelected([]),
          }, '清空勾选'),
          selectMsg && h('span', { className: 'beer-muted' }, selectMsg)),
        !data ? h('div', { className: 'beer-muted' }, '加载中…')
          : !entries.length ? h('div', { className: 'beer-muted' },
            filtered ? '没有符合条件的素材，换一个筛选试试。' : '素材文件夹还是空的。录音转写完成后会自动出现在这里；也可以在对话里让 AI 整理素材。')
            : h('div', { className: 'beer-cards' }, entries.map(entry =>
              // data-path 是稳定的库内路径；多选按它记。
              h('button', {
                key: entry.path,
                className: 'beer-matcard' + (selectMode && selected.includes(entry.path) ? ' on' : ''),
                'data-path': entry.path, title: entry.path,
                onClick: () => (selectMode ? toggleSelected(entry.path) : setDetail(entry)),
              },
              h('div', { className: 'beer-matcard-hd' },
                selectMode && h('span', { className: 'beer-matcheck' }, selected.includes(entry.path) ? '✓' : ''),
                h('b', null, entry.title),
                entry.type && h('span', { className: 'beer-chip' }, entry.type)),
              entry.tags.length > 0 && h('div', { className: 'beer-tags' },
                entry.tags.map(tag => h('span', { key: tag, className: 'beer-chip' }, '#' + tag))),
              h('div', { className: 'beer-muted' }, fmtTime(entry.modifiedAt) + (entry.status ? ' · ' + entry.status : '')),
              entry.summary && h('div', { className: 'beer-sum' }, entry.summary)))))
    }

    // 设置弹层（#33）：顶栏齿轮打开。列出 4 个钥匙串密钥的状态，逐个填写保存；配置项只读。
    // 输入框永远是空的，不回显、不预填已有值；接口也从不返回密钥本身。
    const SECRET_INFO = [
      ['home-api-key', 'Mac mini 家里服务的访问密钥'],
      ['opencode-go-api-key', 'opencode go 的 API key（模型调用、查限额）'],
      ['rin-admin-username', 'Rin 博客管理员账号'],
      ['rin-admin-password', 'Rin 博客管理员密码'],
    ]
    const SECRET_STATUS = {
      present: ['已存', ' ok'],
      missing: ['未存', ' bad'],
      error: ['读取出错', ' bad'],
    }
    const CONFIG_LABELS = [
      ['homeApiBase', '家里服务地址'],
      ['rinApiBase', 'Rin 博客地址'],
      ['opencodeGoBase', 'opencode go 地址'],
      ['audioCacheLimitGB', '录音缓存上限（GB）'],
    ]

    function SecretRow({ name, label, status, onSaved }) {
      const [value, setValue] = useState('')
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')
      const [done, setDone] = useState(false)
      const [text, cls] = SECRET_STATUS[status] ?? ['查询中…', '']
      const save = async e => {
        e.preventDefault()
        if (busy) return
        if (!value.trim()) { setError('先填写密钥再保存'); return }
        setBusy(true)
        setError('')
        setDone(false)
        try {
          await api('PUT', '/settings/secrets/' + encodeURIComponent(name), { value })
          setValue('')
          setDone(true)
          onSaved(name)
        } catch (err) {
          setError(err.message || '保存失败')
        } finally { setBusy(false) }
      }
      return h('div', { className: 'beer-secret' },
        h('div', { className: 'beer-secret-hd' },
          h('b', null, label),
          h('code', null, name),
          h('span', { className: 'beer-chip' + cls }, text),
          done && h('span', { className: 'beer-muted', role: 'status' }, '已保存')),
        h('form', { onSubmit: save },
          h('input', {
            type: 'password', value, autoComplete: 'new-password', spellCheck: false,
            'aria-label': label + '（' + name + '）',
            placeholder: status === 'present' ? '已存，填新值可覆盖' : '填写后点保存',
            onChange: e => { setValue(e.target.value); setError(''); setDone(false) },
          }),
          h('button', { type: 'submit', className: 'beer-btn pri', disabled: busy }, busy ? '保存中…' : '保存')),
        error && h('div', { className: 'beer-err', role: 'alert' }, error))
    }

    function SettingsOverlay({ onClose, onSaved }) {
      const [settings, setSettings] = useState(null) // null = 加载中；{ config, secrets } 或 { error }
      const load = useCallback(async () => {
        try { setSettings(await api('GET', '/settings')) } catch (e) { setSettings({ error: e.message || '读取设置失败' }) }
      }, [])
      useEffect(() => { load() }, [load])
      const saved = name => { load(); onSaved(name) }
      return h('div', {
        className: 'beer-overlay', 'data-dsh-no-drag': '',
        onKeyDown: e => { if (e.key === 'Escape') { e.preventDefault(); onClose() } },
        onClick: e => { if (e.target === e.currentTarget) onClose() },
      },
      h('div', { className: 'beer-modal', role: 'dialog', 'aria-label': 'Beer 设置' },
        h('div', { className: 'beer-searchhd' },
          h('b', { style: { flex: 1 } }, '设置'),
          h('button', { className: 'beer-btn ghost', onClick: onClose, 'aria-label': '关闭设置', autoFocus: true }, '✕')),
        h('div', { className: 'beer-set' },
          settings?.error && h('div', { className: 'beer-err', role: 'alert' }, settings.error),
          h('h3', null, '密钥（存在本机 macOS 钥匙串）'),
          SECRET_INFO.map(([name, label]) => h(SecretRow, {
            key: name, name, label, status: settings?.secrets?.[name], onSaved: saved,
          })),
          h('h3', null, '配置项（只读）'),
          settings?.config
            ? h('dl', { className: 'beer-cfg' },
              CONFIG_LABELS.map(([key, label]) => [
                h('dt', { key: key + '-t' }, label),
                h('dd', { key: key + '-d' }, settings.config[key] == null || settings.config[key] === '' ? '（未设置）' : String(settings.config[key])),
              ]))
            : !settings?.error && h('div', { className: 'beer-muted' }, '加载中…'),
          h('div', { className: 'beer-muted' }, '改地址请改 profile 的 cordis.patch.yml。'))))
    }

    // 顶栏 opencode go 限额：GET /api/beer/quota，5 分钟刷新一次，点一下立即重查。
    const QUOTA_REFRESH_MS = 5 * 60 * 1000
    const QUOTA_SHORT = { '5h': '5h', week: '周', month: '月' }
    function formatReset(iso) {
      if (!iso) return '重置时间未知'
      const d = new Date(iso)
      const when = Number.isNaN(d.getTime()) ? iso : d.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
      return when + ' 重置'
    }
    function QuotaPill() {
      const [quota, setQuota] = useState(null) // null = 查询中；{ limits } 或 { error }
      const load = useCallback(async () => {
        try { setQuota(await api('GET', '/quota')) } catch (e) { setQuota({ error: e.message || '限额查询失败' }) }
      }, [])
      useEffect(() => {
        load()
        const timer = setInterval(load, QUOTA_REFRESH_MS)
        return () => clearInterval(timer)
      }, [load])
      if (!quota) return h('button', { className: 'beer-quota', disabled: true }, 'Go 限额 查询中…')
      if (quota.error) {
        return h('button', { className: 'beer-quota bad', onClick: load, title: quota.error + '（点击重试）' }, 'Go 限额 查询失败')
      }
      const title = 'opencode go 套餐（点击刷新）\n' + quota.limits.map(l =>
        `${l.label}：已用 ${l.percent}%${l.state === 'exhausted' ? '（已用完）' : ''}，${formatReset(l.resetsAt)}`).join('\n')
      return h('button', { className: 'beer-quota', onClick: load, title },
        'Go 限额',
        quota.limits.map((l, i) => h('span', { key: l.window, className: l.state === 'exhausted' ? 'full' : undefined },
          (i ? '· ' : '') + (QUOTA_SHORT[l.window] ?? l.label) + ' ', h('b', null, l.percent + '%'))))
    }

    // ---- 录音分页：拖入上传、五步进度、取回并写入素材、展开摘要 ----

    const REC_POLL_MS = 5000
    const REC_SYNC_MS = 60 * 1000
    const MACHINE_REFRESH_MS = 30 * 1000
    const MACHINE_NAMES = [['mac_mini', 'Mac mini'], ['windows', 'Windows'], ['nas', 'NAS']]
    const REC_STATUS = { processing: '处理中', ready: '待取回', stored: '已入库', failed: '失败' }
    const STEP_MARK = { done: '✓', running: '…', failed: '✕', pending: '○' }
    const SUMMARY_TYPES = ['会议', '口述灵感', '课程讲座']

    function formatBytes(bytes) {
      if (!Number.isFinite(bytes) || bytes <= 0) return ''
      if (bytes < 1024) return bytes + ' B'
      if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
      return (bytes / 1024 / 1024).toFixed(1) + ' MB'
    }

    // 用 XHR 才有上传进度；multipart 字段名和家里服务一致（file）。
    function uploadOne(file, onProgress) {
      return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest()
        xhr.open('POST', API + '/recordings')
        xhr.upload.onprogress = e => { if (e.lengthComputable) onProgress(e.loaded / e.total) }
        xhr.onload = () => {
          let data = {}
          try { data = JSON.parse(xhr.responseText) } catch {}
          if (xhr.status >= 200 && xhr.status < 300) return resolve(data)
          const err = new Error(data?.error?.message || data?.detail || `上传失败（${xhr.status}）`)
          err.status = xhr.status
          err.code = data?.error?.code || data?.error_code
          reject(err)
        }
        xhr.onerror = () => {
          const err = new Error('家里暂时连不上，没有排队，请稍后重试')
          err.code = 'home_unreachable'
          reject(err)
        }
        const form = new FormData()
        form.append('file', file, file.name)
        xhr.send(form)
      })
    }

    // 顶栏：家里三台机器的在线状态，30 秒刷新一次。
    function MachinePill() {
      const [state, setState] = useState(null)
      const load = useCallback(async () => {
        try { setState(await api('GET', '/machines')) } catch (e) { setState({ online: false, error: e.message }) }
      }, [])
      useEffect(() => {
        load()
        const timer = setInterval(load, MACHINE_REFRESH_MS)
        return () => clearInterval(timer)
      }, [load])
      if (!state) return h('span', { className: 'beer-machines' }, '家里 查询中…')
      if (!state.online || !state.machines) {
        return h('button', { className: 'beer-machines bad', onClick: load, title: (state.error || '家里暂时连不上') + '（点击重试）' }, '家里暂时连不上')
      }
      return h('button', { className: 'beer-machines', onClick: load, title: '家里三台机器（点击刷新）' },
        MACHINE_NAMES.map(([key, label]) => h('span', { key, className: 'beer-machine' + (state.machines[key]?.online ? ' on' : '') }, h('i'), label)))
    }

    function RecordingsView({ vaultPath, syncNow, entryPaths, playRequest, onPlayHandled }) {
      const [records, setRecords] = useState(null) // null = 加载中
      const [uploads, setUploads] = useState([])
      const [dragging, setDragging] = useState(false)
      const [error, setError] = useState('')
      const [notice, setNotice] = useState('')
      const [syncing, setSyncing] = useState(false)
      const [retrying, setRetrying] = useState('')
      const [deleting, setDeleting] = useState('')
      const [resummarizing, setResummarizing] = useState('')
      const [draftTypes, setDraftTypes] = useState({}) // 录音编号 → 用户选中的类型（还没重新总结）
      const [opened, setOpened] = useState({}) // 录音编号 → { loading, transcript, error }
      const [playing, setPlaying] = useState(null) // { id, title, startAt, nonce }
      const inputRef = useRef(null)
      const seeked = useRef(false)
      const handledRequest = useRef(null)

      useEffect(() => { seeked.current = false }, [playing])

      // 搜索命中文字稿时，从素材条目的 index.md 里读「录音编号:」，再让播放器跳到 playAt。
      const playFromEntry = useCallback(async request => {
        try {
          const path = String(request?.path ?? '')
          const slash = path.lastIndexOf('/')
          const folder = slash < 0 ? '' : path.slice(0, slash)
          const note = await api('GET', '/library/file?path=' + encodeURIComponent(folder + '/index.md'))
          const m = /^录音编号:[ \t]*(.+?)[ \t]*\r?$/m.exec(note?.content ?? '')
          if (!m) { setError('这条文字稿对应的素材条目里没有录音编号，找不到可播放的音频'); return }
          setPlaying({
            id: m[1],
            title: folder.split('/').pop() || m[1],
            startAt: Number(request?.playAt) || 0,
            nonce: Date.now(),
          })
          setError('')
        } catch (e) {
          setError(e.message || '没能找到这条录音的音频')
        }
      }, [])

      useEffect(() => {
        if (!playRequest || handledRequest.current === playRequest.nonce) return
        handledRequest.current = playRequest.nonce
        playFromEntry(playRequest)
        onPlayHandled?.()
      }, [playRequest, playFromEntry, onPlayHandled])

      const load = useCallback(async () => {
        try {
          const data = await api('GET', '/recordings')
          setRecords(Array.isArray(data.recordings) ? data.recordings : [])
          setError('')
        } catch (e) { setError(e.message) }
      }, [])
      useEffect(() => {
        load()
        const timer = setInterval(load, REC_POLL_MS)
        return () => clearInterval(timer)
      }, [load])

      const updateUpload = (key, patch) => setUploads(prev => prev.map(u => (u.key === key ? { ...u, ...patch } : u)))

      const uploadFiles = async fileList => {
        const files = Array.from(fileList ?? [])
        if (!files.length) return
        setError('')
        setNotice('')
        const queued = files.map((file, i) => ({
          file,
          key: `${Date.now()}-${i}-${file.name}`,
          name: file.name,
          size: file.size,
          progress: 0,
          status: 'uploading',
          error: '',
        }))
        setUploads(prev => [...queued.map(({ file, ...rest }) => rest), ...prev].slice(0, 20))
        for (const item of queued) {
          try {
            await uploadOne(item.file, fraction => updateUpload(item.key, { progress: fraction }))
            updateUpload(item.key, { status: 'done', progress: 1 })
          } catch (e) {
            const message = e.code === 'home_unreachable' ? '家里暂时连不上，没有排队，请稍后重试' : e.message
            updateUpload(item.key, { status: 'error', error: message })
            if (e.code === 'home_unreachable') setError(message)
          }
        }
        load()
      }

      const runSync = async () => {
        if (syncing) return
        setSyncing(true)
        setError('')
        setNotice('')
        try {
          const result = await syncNow()
          const count = result?.imported?.length ?? 0
          setNotice(count ? `已取回 ${count} 条录音，写进素材` : '没有新的录音需要取回')
          await load()
        } catch (e) { setError(e.message) } finally { setSyncing(false) }
      }

      const retry = async id => {
        setRetrying(id)
        try { await api('POST', `/recordings/${encodeURIComponent(id)}/retry`); await load() }
        catch (e) { setError(e.message) } finally { setRetrying('') }
      }

      // 只有失败的录音能删（#30）：家里只删记录，NAS 上的原件留着，删错了可以取原件重新上传。
      const removeFailed = async rec => {
        if (deleting) return
        const name = rec.filename ?? rec.id
        const where = rec.original_path ? `\n\n原件仍保留在 NAS 上：${rec.original_path}\n删错了可以从那里取回原件重新上传。` : '\n\n原件仍保留在 NAS 上，删错了可以从那里取回原件重新上传。'
        if (!window.confirm(`删除失败的录音「${name}」？只删这条录音记录，不进回收站。${where}`)) return
        setDeleting(rec.id)
        setError('')
        setNotice('')
        try {
          await api('DELETE', `/recordings/${encodeURIComponent(rec.id)}`)
          setRecords(prev => (prev ?? []).filter(r => r.id !== rec.id))
          setPlaying(prev => (prev?.id === rec.id ? null : prev))
          setNotice(`已删除「${name}」，原件仍在 NAS 上`)
          await load()
        } catch (e) {
          setError(e.code === 'home_unreachable' ? '家里暂时连不上，没有删除，请稍后重试' : e.message)
        } finally { setDeleting('') }
      }

      // 按选中的类型重做摘要：只换摘要和类型，文字稿、srt 不动。
      const resummarize = async (rec, type) => {
        if (resummarizing) return
        setResummarizing(rec.id)
        setError('')
        setNotice('')
        try {
          const data = await api('POST', `/recordings/${encodeURIComponent(rec.id)}/summarize`, { type })
          setDraftTypes(prev => ({ ...prev, [rec.id]: data.summary_type ?? type }))
          setOpened(prev => ({
            ...prev,
            [rec.id]: {
              loading: false,
              transcript: { ...(prev[rec.id]?.transcript ?? {}), summary: data.summary, summary_type: data.summary_type },
            },
          }))
          setNotice(`已按「${type}」重新总结，文字稿没有改动`)
          await load()
        } catch (e) { setError(e.message) } finally { setResummarizing('') }
      }

      const toggleSummary = async rec => {
        const current = opened[rec.id]
        if (current && !current.loading) {
          setOpened(prev => { const next = { ...prev }; delete next[rec.id]; return next })
          return
        }
        setOpened(prev => ({ ...prev, [rec.id]: { loading: true } }))
        try {
          const transcript = await api('GET', `/recordings/${encodeURIComponent(rec.id)}/transcript`)
          setOpened(prev => ({ ...prev, [rec.id]: { loading: false, transcript } }))
        } catch (e) {
          setOpened(prev => ({ ...prev, [rec.id]: { loading: false, error: e.message } }))
        }
      }

      const openInObsidian = rec => {
        const entry = entryPaths?.[rec.id]
        if (!entry) { setError('这条录音还没取回入库；先点「取回并写入素材」'); return }
        const abs = String(vaultPath).replace(/[\\/]+$/, '') + '/' + entry
        const uri = 'obsidian://open?path=' + encodeURIComponent(abs)
        try { window.open(uri, '_blank') } catch { setError('没能打开 Obsidian，可以在 Obsidian 里按路径找到这条素材') }
      }

      const askAi = async rec => {
        const summary = opened[rec.id]?.transcript?.summary ?? rec.summary
        if (!summary) { setError('这条录音还没有摘要'); return }
        try {
          await navigator.clipboard.writeText(summary)
          setNotice('摘要已复制，粘贴到右侧对话里让 AI 继续讨论')
        } catch { setError('没能复制摘要；可以在摘要里手动选中文字复制') }
      }

      const recordItem = rec => {
        const steps = Array.isArray(rec.steps) ? rec.steps : []
        const progress = Math.max(0, Math.min(100, Number(rec.progress) || 0))
        const summary = opened[rec.id]
        const canSummary = rec.status === 'ready' || rec.status === 'stored'
        const isPlaying = playing?.id === rec.id
        const type = draftTypes[rec.id] ?? rec.summary_type ?? ''
        const chosenType = type || '会议'
        return h('div', { key: rec.id, className: 'beer-rec-item' + (isPlaying ? ' on' : '') },
          h('div', { className: 'beer-rec-hd' },
            h('b', { title: rec.filename }, rec.filename ?? rec.id),
            h('span', { className: 'beer-chip' + (rec.status === 'failed' ? ' bad' : '') }, REC_STATUS[rec.status] ?? rec.status ?? '未知'),
            rec.summary_type && h('span', { className: 'beer-chip' }, rec.summary_type),
            rec.status === 'failed' && h('button', { className: 'beer-btn', onClick: () => retry(rec.id), disabled: retrying === rec.id }, retrying === rec.id ? '重试中…' : '重试'),
            rec.status === 'failed' && h('button', { className: 'beer-btn', onClick: () => removeFailed(rec), disabled: deleting === rec.id, title: '只删记录，NAS 上的原件保留' }, deleting === rec.id ? '删除中…' : '删除')),
          h('div', { className: 'beer-steps' }, steps.map(step =>
            h('span', { key: step.key, className: 'beer-step ' + step.status }, `${STEP_MARK[step.status] ?? '○'} ${step.name}`))),
          progress > 0 && progress < 100 && h('div', { className: 'beer-bar' }, h('i', { style: { width: progress + '%' } })),
          (rec.error_code || rec.error) && h('div', { className: 'beer-err' }, [rec.error_code, rec.error].filter(Boolean).join(' · ')),
          rec.mail_error && h('div', { className: 'beer-err' }, '通知邮件没发出去：' + rec.mail_error),
          h('div', { className: 'beer-actions' },
            h('button', {
              className: 'beer-btn',
              onClick: () => setPlaying(prev => ({
                id: rec.id,
                title: rec.filename ?? rec.id,
                startAt: prev?.id === rec.id ? Number(prev.startAt) || 0 : 0,
                nonce: Date.now(),
              })),
            }, isPlaying ? '重新播放' : '播放'),
            canSummary && h('button', { className: 'beer-btn', onClick: () => toggleSummary(rec) }, summary && !summary.loading ? '收起摘要' : '展开摘要'),
            canSummary && h('select', {
              className: 'beer-mat-select',
              value: chosenType,
              'aria-label': '录音类型',
              onChange: e => setDraftTypes(prev => ({ ...prev, [rec.id]: e.target.value })),
            }, SUMMARY_TYPES.map(t => h('option', { key: t, value: t }, t))),
            canSummary && h('button', {
              className: 'beer-btn',
              onClick: () => resummarize(rec, chosenType),
              disabled: resummarizing === rec.id,
              title: '按选中的类型重做摘要；文字稿和字幕不动',
            }, resummarizing === rec.id ? '重新总结中…' : '重新总结'),
            canSummary && h('button', { className: 'beer-btn', onClick: () => openInObsidian(rec) }, '在 Obsidian 打开'),
            canSummary && h('button', { className: 'beer-btn', onClick: () => askAi(rec) }, '交给 AI 讨论')),
          summary?.loading && h('div', { className: 'beer-muted' }, '读摘要…'),
          summary?.error && h('div', { className: 'beer-err' }, summary.error),
          summary?.transcript && h('div', { className: 'beer-summary' },
            summary.transcript.summary_type && h('div', { className: 'beer-muted' }, `类型：${summary.transcript.summary_type}`),
            summary.transcript.summary
              ? h(MarkdownPreview, { source: summary.transcript.summary })
              : h('span', { className: 'beer-muted' }, '摘要待生成')))
      }

      // 播放器只在用户点播放 / 从搜索结果跳进来时才挂载，音频也到这时才向 Beer 请求。
      const player = playing && h('div', { className: 'beer-player' },
        h('div', { className: 'beer-rec-hd' },
          h('b', { title: playing.title }, playing.title ?? playing.id),
          Number(playing.startAt) > 0 && h('span', { className: 'beer-chip warn' }, `从 ${formatClock(playing.startAt)} 开始`),
          h('button', { className: 'beer-btn ghost', onClick: () => setPlaying(null) }, '关闭播放器')),
        h('audio', {
          key: `${playing.id}|${playing.startAt ?? 0}|${playing.nonce}`,
          controls: true,
          autoPlay: true,
          preload: 'metadata',
          src: `${API}/recordings/${encodeURIComponent(playing.id)}/audio`,
          onLoadedMetadata: e => {
            const at = Number(playing.startAt) || 0
            if (at <= 0 || seeked.current) return
            seeked.current = true
            try { e.currentTarget.currentTime = at } catch {}
          },
          onError: () => setError('这条录音的音频暂时播不出来；家里连不上或原件还没准备好'),
        }),
        h('div', { className: 'beer-muted' }, '第一次播放会从家里下载到本机缓存，之后直接读本地；拖动进度条只取需要的那一段。'))

      const dropText = dragging ? '松手就开始上传' : '把录音拖到这里上传（可以多选），或点这里选文件'
      return h('div', { className: 'beer-rec' },
        player,
        h('div', {
          className: 'beer-drop' + (dragging ? ' on' : ''),
          role: 'button',
          tabIndex: 0,
          onDragEnter: e => { e.preventDefault(); setDragging(true) },
          onDragOver: e => { e.preventDefault(); setDragging(true) },
          onDragLeave: e => { if (e.currentTarget === e.target) setDragging(false) },
          onDrop: e => { e.preventDefault(); setDragging(false); uploadFiles(e.dataTransfer?.files) },
          onClick: () => inputRef.current?.click(),
          onKeyDown: e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); inputRef.current?.click() } },
        },
          h('div', null, dropText),
          h('div', { className: 'beer-muted' }, '不用选类型；上传后交给家里转写。连不上家里时直接报错，不会排队。'),
          h('input', {
            ref: inputRef, type: 'file', multiple: true, accept: 'audio/*,video/*', style: { display: 'none' },
            onClick: e => e.stopPropagation(),
            onChange: e => { uploadFiles(e.target.files); e.target.value = '' },
          })),
        uploads.length > 0 && h('div', { className: 'beer-rec-list' }, uploads.map(u =>
          h('div', { key: u.key, className: 'beer-rec-item' },
            h('div', { className: 'beer-rec-hd' },
              h('b', { title: u.name }, u.name),
              h('span', { className: 'beer-chip' + (u.status === 'error' ? ' bad' : '') },
                u.status === 'uploading' ? `上传中 ${Math.round(u.progress * 100)}%` : u.status === 'done' ? '已上传' : '上传失败'),
              h('span', { className: 'beer-muted' }, formatBytes(u.size))),
            u.status === 'uploading' && h('div', { className: 'beer-bar' },
              h('i', { style: { width: Math.max(2, Math.round(u.progress * 100)) + '%' } })),
            u.error && h('div', { className: 'beer-err' }, u.error)))),
        notice && h('div', { className: 'beer-muted', role: 'status' }, notice),
        error && h('div', { className: 'beer-err', role: 'alert' }, error),
        h('div', { className: 'beer-actions' },
          h('button', { className: 'beer-btn pri', onClick: runSync, disabled: syncing }, syncing ? '取回中…' : '取回并写入素材'),
          h('button', { className: 'beer-btn', onClick: load }, '刷新')),
        records === null
          ? h('div', { className: 'beer-muted' }, '加载中…')
          : records.length === 0
            ? h('div', { className: 'beer-muted' }, '家里还没有录音。把手机录的音拖到上面吧。')
            : h('div', { className: 'beer-rec-list' }, records.map(recordItem)))
    }

    function BusinessPanel({ service: hostService, conversation }) {
      const service = workbenchService(hostService)
      const rootRef = useRef(null)
      const width = useContainerWidth(rootRef)
      const ownedSessionId = useOwnedSession(service)
      const owned = !!ownedSessionId
      const contextTokens = useContextTokens(ownedSessionId)
      const [vault, setVault] = useState(null)
      const [panel, setPanel] = useState(null)
      const [tab, setTab] = useState('home')
      const [formOpen, setFormOpen] = useState(false)
      const [error, setError] = useState('')
      const [busy, setBusy] = useState(false)
      const [entryPaths, setEntryPaths] = useState({}) // 录音编号 → 素材条目路径（从 sync 结果记下，打开 Obsidian 用）
      const [searchInput, setSearchInput] = useState('')
      const [searchOpen, setSearchOpen] = useState(false)
      const [settingsOpen, setSettingsOpen] = useState(false)
      // 设置里保存了密钥后让顶栏的状态立即重查：换 key 让组件重新挂载。
      const [pillKeys, setPillKeys] = useState({ quota: 0, machines: 0 })
      const onSecretSaved = useCallback(name => {
        if (name === 'opencode-go-api-key') setPillKeys(k => ({ ...k, quota: k.quota + 1 }))
        if (name === 'home-api-key') setPillKeys(k => ({ ...k, machines: k.machines + 1 }))
      }, [])
      const [openRequest, setOpenRequest] = useState(null)
      const [playRequest, setPlayRequest] = useState(null) // 搜索命中的文字稿：切到录音分页并从 playAt 开始播
      const [notice, setNotice] = useState('')
      const searchRef = useRef(null)
      const noticeTimer = useRef(null)

      const notify = useCallback(text => {
        setNotice(text)
        clearTimeout(noticeTimer.current)
        noticeTimer.current = setTimeout(() => setNotice(''), 5000)
      }, [])
      useEffect(() => () => clearTimeout(noticeTimer.current), [])

      // ⌘K / Ctrl+K：把焦点放到顶栏搜索框（不打开浮层，回车再搜）。
      useEffect(() => {
        const onKey = e => {
          if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return
          if (e.key.toLowerCase() !== 'k' || searchOpen || settingsOpen) return
          e.preventDefault()
          searchRef.current?.focus()
          searchRef.current?.select?.()
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [searchOpen, settingsOpen])

      const load = useCallback(async () => {
        try {
          const [v, p] = await Promise.all([api('GET', '/vault'), api('GET', '/panel')])
          setVault(v)
          setPanel(p)
          setError('')
        } catch (e) { setError(e.message) }
      }, [])
      useEffect(() => { load() }, [load])

      // 取回录音结果：记下每条写到了哪个素材条目，并返回家里的 sync 结果。
      const syncNow = useCallback(async () => {
        const result = await api('POST', '/recordings/sync')
        const paths = {}
        for (const item of [...(result?.imported ?? []), ...(result?.skipped ?? [])]) {
          if (item?.id && item?.path) paths[item.id] = item.path
        }
        if (Object.keys(paths).length) setEntryPaths(prev => ({ ...prev, ...paths }))
        return result
      }, [])

      // Beer 打开时取回一次，之后每 60 秒一次。家里连不上时顶栏已经提示，这里不重复报错。
      useEffect(() => {
        if (vault?.status !== 'ready') return
        const run = () => { syncNow().catch(() => {}) }
        run()
        const timer = setInterval(run, REC_SYNC_MS)
        return () => clearInterval(timer)
      }, [vault?.status, syncNow])

      const chooseVault = async () => {
        setBusy(true)
        try {
          const path = await pickDirectory()
          if (!path) return null // 取消：什么都不留下
          const v = await api('PUT', '/vault', { path })
          setVault(v)
          setError('')
          return v
        } catch (e) { setError(e.message); return null } finally { setBusy(false) }
      }

      // 「开始对话」恢复记住的会话；「新对话」（fresh）不带编号调 ensureSession，
      // 宿主一定新建一个本工作台的会话（旧会话留在 DSH 里），再改记新编号。
      const openChat = async ({ fresh = false } = {}) => {
        setBusy(true)
        try {
          let v = vault
          if (v?.status !== 'ready') { setBusy(false); v = await chooseVault(); setBusy(true) }
          if (v?.status !== 'ready') return
          const savedId = fresh ? undefined : panel?.sessionId || undefined
          let result
          try {
            result = await service.ensureSession({ folder: v.path, sessionId: savedId })
          } catch (e) {
            if (!savedId) throw e
            result = await service.ensureSession({ folder: v.path }) // 记住的会话已不在：新建
          }
          const sessionId = typeof result === 'string' ? result : result?.sessionId ?? result?.id
          if (sessionId) {
            await api('PUT', '/panel/session', { sessionId })
            setPanel(p => p && { ...p, sessionId })
          }
          setError('')
        } catch (e) { setError(e.message || (fresh ? '新建对话失败，请重试' : '开始对话失败，请重试')) } finally { setBusy(false) }
      }
      const startChat = () => openChat()
      const newChat = () => openChat({ fresh: true })

      const collapsed = panel ? !!panel.chatCollapsed[tab] : tab === 'publish'
      const toggleChat = async () => {
        const next = !collapsed
        setPanel(p => p && { ...p, chatCollapsed: { ...p.chatCollapsed, [tab]: next } })
        try { await api('PUT', `/panel/chat/${encodeURIComponent(tab)}`, { collapsed: next }) } catch (e) { setError(e.message) }
      }

      // 新建成功后重新拉一次分页列表，再切到新分页。
      const createTab = async created => {
        const p = await api('GET', '/panel')
        setPanel(p)
        setTab(created.id)
        setFormOpen(false)
        setError('')
      }

      // 只删分页，库里的文件夹和文件都不动；删完回首页。
      const removeTab = async current => {
        if (!window.confirm(`删除自定义分页「${current.title}」？只删这个分页，库里的文件夹和文件都不会动。`)) return
        setBusy(true)
        try {
          await api('DELETE', '/panel/tabs/' + encodeURIComponent(current.id))
          const p = await api('GET', '/panel')
          setPanel(p)
          setTab('home')
          setError('')
        } catch (e) { setError(e.message) } finally { setBusy(false) }
      }

      const tabs = panel?.tabs ?? []
      const current = tabs.find(t => t.id === tab)
      const chatWidth = collapsed ? 44 : Math.max(260, Math.min(360, Math.round(width * 0.36)))

      // 把一段文字放进宿主对话草稿；会话还没准备好时重试几次，最后退回剪贴板。
      const attachToConversation = useCallback(async text => {
        const sessionId = panel?.sessionId || currentSessionId(service)
        for (let attempt = 0; attempt < 3 && sessionId; attempt++) {
          const input = conversationInputOf(service, sessionId)
          if (input) {
            try { appendToDraft(input, text); return 'draft' } catch {}
          }
          await new Promise(resolve => setTimeout(resolve, 400))
        }
        return (await copyText(text)) ? 'clipboard' : 'failed'
      }, [panel?.sessionId, service])

      const attachHit = async hit => {
        const result = await attachToConversation(hitReference(hit))
        notify(result === 'draft' ? '已附到对话草稿，确认后自己发送。'
          : result === 'clipboard' ? '没有可用对话，已复制到剪贴板；先点「开始对话」再粘贴。'
            : '没能放进对话，也没能复制，请手动复制路径。')
      }

      const askAI = async query => {
        const q = (query || '').trim()
        if (!q) { notify('先输入要找的内容。'); return }
        const prompt = `在 Obsidian 库里按意思找：「${q}」。先读相关文件再回答，列出文件路径和命中的原话。`
        const result = await attachToConversation(prompt)
        notify(result === 'draft' ? '已把问题附到对话草稿。'
          : result === 'clipboard' ? '已复制问题到剪贴板；先点「开始对话」再粘贴。'
            : '没能附到对话，也没能复制。')
      }

      // 文字稿归在「录音」组，但录音分页只有列表、打不开文件；文字稿就在素材条目里，到素材分页打开它。
      const openHit = hit => {
        const tabId = hit.kind === 'transcript' ? 'materials' : hit.tabId
        setSearchOpen(false)
        setTab(tabId)
        setOpenRequest({ tabId, path: hit.path, nonce: Date.now() + Math.random() })
      }

      // 文字稿命中带 playAt：切到录音分页，播放器加载这条录音并 seek 到那一句。
      const playFromHit = hit => {
        setSearchOpen(false)
        setTab('recordings')
        setPlayRequest({ path: hit.path, playAt: hit.playAt, nonce: Date.now() + Math.random() })
      }
      const clearPlayRequest = useCallback(() => setPlayRequest(null), [])

      // 选题分页建出选题后切到文章分页并打开那一篇。
      const openArticle = path => {
        setTab('articles')
        setOpenRequest({ tabId: 'articles', path, nonce: Date.now() + Math.random() })
      }

      // 首页的编辑冲突：按路径找到能打开它的分页（文章 / 素材 / 选题简报 / 自定义分页），
      // 切过去并让那个分页打开这份文件；找不到分页时回首页并提示用顶栏搜索。
      const openConflict = path => {
        const fixed = path.startsWith('内容库/文章/') ? 'articles'
          : path.startsWith('内容库/素材/') ? 'materials'
            : path.startsWith('内容库/选题简报/') ? 'topics'
              : path.startsWith('内容库/规则/') ? 'rules'
                : null
        const custom = fixed ? null : tabs.find(t => t.folder && (path === t.folder || path.startsWith(t.folder + '/')))
        const tabId = fixed ?? custom?.id
        if (!tabId) {
          notify(`没有能打开 ${path} 的分页，可以用顶栏搜索打开它。`)
          return
        }
        setTab(tabId)
        if (tabId !== 'topics' && tabId !== 'rules') setOpenRequest({ tabId, path, nonce: Date.now() + Math.random() })
      }

      const vaultReady = vault?.status === 'ready'
      let content
      if (!vault) content = h('div', { className: 'beer-muted' }, '加载中…')
      else if (!vaultReady) {
        content = h('div', { className: 'beer-card' },
          h('h2', null, vault.status === 'missing' ? '之前选的 Obsidian 库找不到了' : '选择你的 Obsidian 库'),
          h('p', { className: 'beer-muted' }, vault.status === 'missing'
            ? `原来的位置：${vault.path}。请重新选择，Beer 不会自动新建文件夹。`
            : 'Beer 的所有分页都读写这个库。选一次之后会记住；取消不会留下任何东西。'),
          h('button', { className: 'beer-btn pri', onClick: chooseVault, disabled: busy }, '选择 Obsidian 库…'))
      } else if (current?.id === 'home') {
        content = h(HomeView, {
          key: `${vault.path}|home`,
          narrow: width - chatWidth < 760,
          onOpenTab: setTab,
          onOpenConflict: openConflict,
          onError: setError,
        })
      } else if (current?.id === 'topics') {
        content = h(TopicsView, {
          key: `${vault.path}|topics`, service, panel,
          onError: setError,
          onOpenArticles: openArticle,
        })
      } else if (current?.id === 'materials') {
        content = h(MaterialsView, {
          key: `${vault.path}|materials`,
          narrow: width - chatWidth < 640,
          onError: setError,
          openRequest: openRequest && openRequest.tabId === 'materials' ? openRequest : null,
        })
      } else if (current?.id === 'recordings') {
        content = h(RecordingsView, {
          key: vault.path, vaultPath: vault.path, syncNow, entryPaths,
          playRequest, onPlayHandled: clearPlayRequest,
        })
      } else if (current?.id === 'trash') {
        content = h(TrashView, {
          key: `${vault.path}|trash`,
          onError: setError,
          openRequest: openRequest && openRequest.tabId === 'trash' ? openRequest : null,
        })
      } else if (current?.id === 'articles') {
        content = h(ArticlesView, {
          key: `${vault.path}|articles`, service, panel,
          narrow: width - chatWidth < 700, onError: setError,
          openRequest: openRequest && openRequest.tabId === 'articles' ? openRequest : null,
        })
      } else if (current?.id === 'publish') {
        content = h(PublishView, {
          key: `${vault.path}|publish`,
          narrow: width - chatWidth < 700,
          onError: setError,
        })
      } else if (current?.id === 'rules') {
        content = h(RulesView, { key: `${vault.path}|rules`, onError: setError })
      } else if (current?.folder) {
        const view = current.style === 'list'
          ? h(EntryListView, {
            key: `${vault.path}|${current.id}|list`,
            folder: current.folder,
            tabId: current.id,
            tabTitle: current.title,
            onError: setError,
            openRequest: openRequest && openRequest.tabId === current.id ? openRequest : null,
          })
          : h(LibraryView, {
            key: `${vault.path}|${current.id}`,
            folder: current.folder,
            tabId: current.id,
            tabTitle: current.title,
            narrow: width - chatWidth < 640,
            onError: setError,
            openRequest: openRequest && openRequest.tabId === current.id ? openRequest : null,
          })
        content = current.custom
          ? h('div', null,
            h('div', { className: 'beer-custom-bar' },
              h('span', { title: current.folder }, `自定义分页 · ${current.style === 'list' ? '条目列表' : '笔记'} · ${current.folder}`),
              h('button', { className: 'beer-btn ghost', onClick: () => removeTab(current), disabled: busy }, '删除这个分页')),
            view)
          : view
      } else {
        content = h('div', { className: 'beer-muted' }, '加载中…')
      }

      const chatEmpty = !owned && h('div', { className: 'beer-chat-empty' },
        h('div', { className: 'beer-muted' }, '需要 AI 帮忙时再开始对话。'),
        h('button', { className: 'beer-btn pri', onClick: startChat, disabled: busy }, panel?.sessionId ? '继续对话' : '开始对话'))
      const chatLong = owned && contextTokens != null && contextTokens >= LONG_CHAT_TOKENS
        && h('div', { className: 'beer-chat-long', role: 'status' }, '对话已经很长，可以点「新对话」新开。')

      // 固定分页在竖线左边，用「＋」加的分页在右边（布局见 docs/layouts/v3.html）。
      const renderTab = t => h('button', {
        key: t.id, role: 'tab', 'aria-selected': t.id === tab,
        className: 'beer-tab' + (t.id === tab ? ' on' : ''), onClick: () => setTab(t.id),
        title: t.custom ? `自定义分页 · ${t.folder}` : undefined,
      }, (t.id === 'home' ? '⌂ ' : '') + t.title)
      const fixedTabs = tabs.filter(t => !t.custom)
      const customTabs = tabs.filter(t => t.custom)

      return h('div', { className: 'beer', ref: rootRef },
        h('style', null, CSS),
        h('header', { 'data-dsh-workbench-toolbar': '', className: 'beer-top' },
          h('span', { className: 'beer-ttl' }, 'Beer'),
          h('input', {
            ref: searchRef,
            className: 'beer-search',
            value: searchInput,
            placeholder: `搜索整个 Obsidian 库 ${SEARCH_KEY}`,
            'aria-label': '搜索整个 Obsidian 库',
            onChange: e => setSearchInput(e.target.value),
            onKeyDown: e => {
              if (e.key === 'Enter' && !e.nativeEvent?.isComposing) { e.preventDefault(); setSearchOpen(true) }
            },
          }),
          h(MachinePill, { key: 'machines-' + pillKeys.machines }),
          h(QuotaPill, { key: 'quota-' + pillKeys.quota }),
          h('button', {
            type: 'button', className: 'beer-gear', onClick: () => setSettingsOpen(true),
            title: '设置：填写钥匙串密钥', 'aria-label': '设置', 'aria-expanded': settingsOpen,
          }, '⚙'),
          h('div', { className: 'beer-vault' },
            vaultReady && h('span', { title: vault.path }, vault.path),
            vaultReady && h('button', { className: 'beer-btn ghost', onClick: chooseVault, disabled: busy }, '更换库'))),
        error && h('div', { className: 'beer-err', role: 'alert' }, error),
        notice && h('div', { className: 'beer-toast', role: 'status' }, notice),
        h('div', { className: 'beer-body' },
          h('div', { className: 'beer-biz' },
            h('nav', { className: 'beer-tabs', role: 'tablist' },
              fixedTabs.map(renderTab),
              customTabs.length > 0 && h('span', { key: 'sep', className: 'beer-tabs-sep', 'aria-hidden': true }),
              customTabs.map(renderTab),
              vaultReady && h('button', {
                key: 'add', type: 'button', className: 'beer-tab-add',
                onClick: () => setFormOpen(open => !open), 'aria-expanded': formOpen,
                title: '添加自定义分页', 'aria-label': '添加自定义分页',
              }, '＋')),
            formOpen && h(TabForm, { onCreate: createTab, onCancel: () => setFormOpen(false) }),
            h('div', { className: 'beer-content' }, content)),
          h('aside', { className: 'beer-chat' + (collapsed ? ' mini' : ''), style: { width: chatWidth } },
            h('div', { className: 'beer-chat-hd' },
              h('button', { className: 'beer-btn ghost', onClick: toggleChat, 'aria-label': collapsed ? '展开对话栏' : '收起对话栏' }, collapsed ? '⇤' : '⇥ 收起'),
              collapsed ? h('span', { className: 'beer-v' }, 'AI 对话') : h('b', null, 'AI'),
              // 没有对话时只显示「开始对话」（宿主规范），「新对话」只在已有对话时出现
              !collapsed && owned && h('button', {
                className: 'beer-btn ghost beer-chat-new', onClick: newChat, disabled: busy,
                title: '新建一个对话，当前对话留在 DSH 里',
              }, '＋ 新对话')),
            // 宿主的原生对话节点始终挂着，收起时只隐藏，不卸载
            h('div', { className: 'beer-chat-mount', style: { display: collapsed ? 'none' : 'flex' } },
              chatEmpty,
              chatLong,
              conversation))),
        settingsOpen && h(SettingsOverlay, { onClose: () => setSettingsOpen(false), onSaved: onSecretSaved }),
        searchOpen && h(SearchOverlay, {
          initialQuery: searchInput,
          onClose: () => setSearchOpen(false),
          onOpen: openHit,
          onAttach: attachHit,
          onAskAI: askAI,
          onPlayFrom: playFromHit,
        }))
    }

    function apply(ctx) {
      hostCtx = ctx
      ctx.effect(() => ctx.desktopWorkbenches.register({
        title: 'Beer',
        description: '录音、素材、选题、文章、发布都在这里完成，内容落在你的 Obsidian 库',
        customFrame: true,
        headerLayout: 'compact',
      }, BusinessPanel))
    }

    return { apply, inject: ['desktopWorkbenches', 'sessions'] }
  },
})
