import React from 'react';
import { createRoot } from 'react-dom/client';
import { ThemeProvider, createTheme, CssBaseline, Container } from '@mui/material';
import App from './ui/App';

const theme = createTheme({
  palette: {
    mode: 'dark'
  }
});

const root = createRoot(document.getElementById('root')!);
root.render(
  <React.StrictMode>
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <Container maxWidth="lg">
        <App />
      </Container>
    </ThemeProvider>
  </React.StrictMode>
);
