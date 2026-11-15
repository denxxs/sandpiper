// Sandpiper — a self-hosted, real-time collaborative workspace.
// Copyright (C) 2026 Dennis Sagayanathan
//
// This program is free software: you can redistribute it and/or modify it under the terms of the GNU Affero
// General Public License as published by the Free Software Foundation, version 3.
//
// This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the
// implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero General Public
// License for more details.
//
// You should have received a copy of the GNU Affero General Public License along with this program. If not, see
// <https://www.gnu.org/licenses/>.

import { createRoot } from "react-dom/client";
import "@blocknote/core/fonts/inter.css";
import "@blocknote/mantine/style.css";
import "./styles.css";
import { App } from "./App";
import { ConnectApp } from "./components/Connect";

// /connect is where AI apps send people to approve them; everything else is the workspace.
createRoot(document.getElementById("root")!).render(location.pathname === "/connect" ? <ConnectApp /> : <App />);
