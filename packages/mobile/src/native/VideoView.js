// RN-обёртка нативного <PrizrakVideoView role="local|remote" />.
import {requireNativeComponent, Platform, View} from 'react-native';

let Native = null;
try {
  if (Platform.OS === 'android') Native = requireNativeComponent('PrizrakVideoView');
} catch {}

export default function VideoView(props) {
  if (!Native) return <View {...props} />;
  return <Native {...props} />;
}
