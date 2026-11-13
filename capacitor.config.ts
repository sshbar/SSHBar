import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'com.nicuorlov.sshbar',
  appName: 'SSHbar',
  webDir: 'out/mobile',
  android: {
    allowMixedContent: false,
    backgroundColor: '#0f1218'
  },
  plugins: {
    // light status/navigation bar icons on the dark UI
    SystemBars: { style: 'DARK' }
  }
}

export default config
