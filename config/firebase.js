import { initializeApp, applicationDefault } from "firebase-admin/app";
import {getMessaging } from "firebase-admin/messaging";

initializeApp({
	credenial: applicationDefault()
	});
export const messaging = getMessaging();